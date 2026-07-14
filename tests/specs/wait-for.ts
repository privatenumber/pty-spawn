import { EventEmitter, on } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
	describe, expect, skip, test,
} from 'manten';
import { spawnNode } from '../utils/spawn-node.ts';
import {
	waitFor,
	type Result,
	type Subprocess,
} from '#pty-spawn';

const createWaitForSubprocessStub = ({
	exitCode,
}: {
	exitCode?: number;
} = {}) => {
	// eslint-disable-next-line unicorn/prefer-event-target
	const emitter = new EventEmitter();
	let currentExitCode = exitCode;
	const { promise, resolve } = Promise.withResolvers<Result>();

	if (currentExitCode !== undefined) {
		resolve({
			output: '',
			exitCode: currentExitCode,
			file: 'stub',
			args: [],
			durationMs: 0,
		});
	}

	const iterateOutput = async function* iterateOutput() {
		if (currentExitCode !== undefined) {
			return;
		}

		const abort = new AbortController();
		emitter.once('exit', () => abort.abort());

		try {
			for await (const [chunk] of on(emitter, 'data', { signal: abort.signal })) {
				yield chunk as string;
			}
		} catch {
			// Abort is expected on exit.
		}
	};

	const subprocess = Object.assign(promise, {
		[Symbol.asyncIterator]: iterateOutput,
	}) as unknown as Subprocess;

	return {
		subprocess,
		emitData: (chunk: string) => {
			emitter.emit('data', chunk);
		},
		emitExit: (code: number) => {
			currentExitCode = code;
			emitter.emit('exit', code);
			resolve({
				output: '',
				exitCode: code,
				file: 'stub',
				args: [],
				durationMs: 0,
			});
		},
	};
};

describe('waitFor', () => {
	// Skipped on Windows: ConPTY is not classic stdin redirection — it emulates
	// a console session via pipes, so stdin writes go through a pipe → conhost
	// → console input buffer → child process chain. This means:
	// - Pipe close doesn't signal EOF to the child
	//   https://github.com/microsoft/terminal/issues/11008
	// - Input sequences can be transformed or swallowed
	//   https://github.com/microsoft/terminal/issues/12166
	// - Stream I/O and console events don't compose cleanly
	//   https://github.com/microsoft/terminal/issues/394
	// - stdin write performance degrades significantly
	//   https://github.com/microsoft/node-pty/issues/327
	// The child process may never receive the written data, causing the test to
	// hang until timeout. This is a ConPTY architectural limitation, not a bug
	// in node-pty or this library.
	test('works with stdin.write', async () => {
		if (process.platform === 'win32') {
			skip('ConPTY stdin delivery is unreliable on Windows');
		}

		const subprocess = spawnNode([
			"console.log('READY')",
			'process.stdin.resume()',
			"process.stdin.once('data', () => process.exit(0))",
		].join(';'));

		await waitFor(subprocess, output => output.includes('READY'));
		subprocess.stdin.write('\n');

		const result = await subprocess;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('READY');
	});

	test('rejects on signal timeout', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		try {
			const error = await waitFor(subprocess, () => false, {
				signal: AbortSignal.timeout(60),
			}).catch((error_: unknown) => error_);
			expect((error as Error).name).toBe('TimeoutError');
		} finally {
			await subprocess.kill();
		}
	});

	test('preserves an external abort reason', async () => {
		for (const reason of [new Error('wait aborted'), { code: 'USER_ABORT' }]) {
			const controller = new AbortController();
			const subprocess = spawnNode('setInterval(() => {}, 1000)');

			try {
				setTimeout(() => {
					controller.abort(reason);
				}, 30);

				const error = await waitFor(subprocess, () => false, {
					signal: controller.signal,
				}).catch((error_: unknown) => error_);
				expect(error).toBe(reason);
			} finally {
				await subprocess.kill();
			}
		}
	});

	test('rejects immediately for a pre-aborted signal', async () => {
		const reason = new Error('already aborted');
		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		try {
			const error = await waitFor(subprocess, () => false, {
				signal: AbortSignal.abort(reason),
			}).catch((error_: unknown) => error_);
			expect(error).toBe(reason);
		} finally {
			await subprocess.kill();
		}
	});

	test('rejects when the predicate throws', async () => {
		const subprocess = spawnNode([
			"console.log('READY')",
			'setInterval(() => {}, 1000)',
		].join(';'));

		try {
			const error = await waitFor(subprocess, () => {
				throw new Error('predicate boom');
			}).catch((error_: unknown) => error_);
			expect((error as Error).message).toContain('predicate boom');
		} finally {
			await subprocess.kill();
		}
	});

	test('timeout is not delayed by burst output and a slow predicate', async () => {
		const { subprocess, emitData } = createWaitForSubprocessStub();

		let predicateCalls = 0;
		const startedAt = Date.now();
		const waitPromise = waitFor(
			subprocess,
			async () => {
				predicateCalls += 1;
				await delay(1);
				return false;
			},
			{ signal: AbortSignal.timeout(200) },
		);

		await delay(10);
		for (let index = 0; index < 5000; index += 1) {
			emitData('x');
		}

		const error = await waitPromise.catch((error_: unknown) => error_);
		const elapsedMs = Date.now() - startedAt;
		expect((error as Error).name).toBe('TimeoutError');
		// Primary assertion is predicateCalls below — elapsedMs is a secondary
		// sanity check. Windows CI is looser due to timer resolution (~15ms)
		// and resource contention inflating wall-clock time.
		const maxElapsedMs = process.platform === 'win32' ? 5000 : 3000;
		expect(elapsedMs < maxElapsedMs).toBe(true);
		expect(predicateCalls < 5000).toBe(true);
	});

	test('rejects when the process exits while waiting', async () => {
		const { subprocess, emitExit } = createWaitForSubprocessStub();
		setTimeout(() => {
			emitExit(0);
		}, 50);
		const error = await waitFor(
			subprocess,
			() => false,
		).catch((error_: unknown) => error_);
		expect((error as Error).message).toContain('Process exited with code 0');
	});

	test('rejects when the process already exited', async () => {
		const subprocess = spawnNode('process.exit(0)');
		await subprocess;

		const error = await waitFor(subprocess, () => false).catch((error_: unknown) => error_);
		expect((error as Error).message).toContain('Process exited with code 0');
	});

	test('truncates the error output tail to 200 characters', async () => {
		const { subprocess, emitData, emitExit } = createWaitForSubprocessStub();
		const longOutput = `HEAD-${'x'.repeat(260)}-TAIL`;

		const waitPromise = waitFor(
			subprocess,
			() => false,
		);

		await delay(10);
		emitData(longOutput);
		await delay(10);
		emitExit(1);

		const error = await waitPromise.catch((error_: unknown) => error_);
		const { message } = error as Error;
		expect(message).toContain(JSON.stringify(longOutput.slice(-200)));
		expect(message.includes('HEAD-')).toBe(false);
	});
});
