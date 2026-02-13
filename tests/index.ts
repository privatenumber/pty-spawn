import { EventEmitter, on } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
	describe, test, expect, skip, setProcessTimeout,
} from 'manten';
import {
	spawn,
	SubprocessError,
	waitFor,
	type Options,
	type Result,
	type Subprocess,
} from '#pty-spawn';

// Workaround for node-pty Windows issues:
// https://github.com/microsoft/node-pty/issues/887
//
// node-pty on Windows has unhandled errors in its internal conpty cleanup:
// - "Signals not supported on windows" from deferred kill() calls
// - "AttachConsole failed" from conpty_console_list_agent.js
// These crash the process if not caught. Swallow them during tests.
// Additionally, node-pty leaves background conpty agents that prevent clean exit,
// so we force exit after a generous timeout.
if (process.platform === 'win32') {
	process.on('uncaughtException', (error) => {
		const { message } = error;
		if (message === 'Signals not supported on windows.' || message === 'AttachConsole failed') {
			return;
		}
		console.error('Uncaught exception:', error); // eslint-disable-line no-console
		process.exit(1); // eslint-disable-line n/no-process-exit
	});

	setProcessTimeout(10 * 60 * 1000);
}

const defaultWindow = {
	cols: 80,
	rows: 24,
} as const;

const spawnNode = (script: string, options: Options = {}) => spawn(
	process.execPath,
	['-e', script],
	{
		window: defaultWindow,
		...options,
	},
);

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
			// abort expected on exit
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

await describe('pty-spawn', () => {
	test('await subprocess resolves with output', async () => {
		const subprocess = spawnNode("console.log('hello from pty')");

		const result = await subprocess;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('hello from pty');
	}, { retry: 2 });

	test('subprocess.output accumulates output synchronously', async () => {
		const subprocess = spawnNode("console.log('hello from pty')");

		expect(subprocess.output).toBe('');

		await waitFor(subprocess, output => output.includes('hello from pty'));
		expect(subprocess.output).toContain('hello from pty');

		await subprocess;
	}, { retry: 2 });

	test('result includes metadata and output', async () => {
		const subprocess = spawnNode("process.stdout.write('meta')");

		expect(typeof subprocess.pid).toBe('number');

		const result = await subprocess;
		expect(result.output).toContain('meta');
		expect(result.file).toBe(process.execPath);
		expect(result.args[0]).toBe('-e');
		expect(typeof result.durationMs).toBe('number');
		expect(result.durationMs >= 0).toBe(true);
	}, { retry: 2 });

	test('result preserves edge-case args verbatim', async () => {
		const edgeArgs = [
			'double "quote"',
			"single 'quote'",
			'line-1\nline-2',
			'',
			'$HOME * ; |',
		];
		const args = [
			'-e',
			'process.exit(0)',
			...edgeArgs,
		];
		const subprocess = spawn(process.execPath, args, {
			window: defaultWindow,
		});

		const result = await subprocess;
		expect(result.file).toBe(process.execPath);
		expect(result.args).toEqual(args);
	});

	test('spawn(file, options) overload works', async () => {
		const subprocess = spawn(process.execPath, {
			window: defaultWindow,
			timeout: 40,
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).message).toContain('Subprocess aborted');
	});

	test('spawn throws for invalid timeout', () => {
		for (const timeout of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			let error: unknown;
			try {
				spawn(process.execPath, {
					window: defaultWindow,
					timeout,
				});
			} catch (error_) {
				error = error_;
			}

			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toContain('options.timeout must be a non-negative finite number');
		}
	});

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
	test('waitFor works with stdin.write', async () => {
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

	test('waitFor rejects on signal timeout', async () => {
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

	test('waitFor rejects with external abort reason', async () => {
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

	test('waitFor rejects immediately for pre-aborted signal', async () => {
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

	test('waitFor rejects when predicate throws', async () => {
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

	test('waitFor timeout is not delayed by burst output and slow predicate', async () => {
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

	test('waitFor rejects when process exits while waiting', async () => {
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

	test('waitFor rejects when process already exited', async () => {
		const subprocess = spawnNode('process.exit(0)');
		await subprocess;

		const error = await waitFor(subprocess, () => false).catch((error_: unknown) => error_);
		expect((error as Error).message).toContain('Process exited with code 0');
	});

	test('waitFor error output tail is truncated to 200 chars', async () => {
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

	test('subprocess is async iterable', async () => {
		const subprocess = spawnNode([
			String.raw`process.stdout.write('alpha\n')`,
			String.raw`setTimeout(() => process.stdout.write('beta\n'), 60)`,
			'setTimeout(() => process.exit(0), 120)',
		].join(';'));

		let streamed = '';
		for await (const chunk of subprocess) {
			streamed += chunk;
		}

		expect(streamed).toContain('alpha');
		expect(streamed).toContain('beta');
	});

	test('subprocess iterator started after exit completes immediately', async () => {
		const subprocess = spawnNode("console.log('done')");
		await subprocess;

		const collect = async () => {
			let chunks = 0;
			for await (const _chunk of subprocess) {
				chunks += 1;
			}
			return chunks;
		};

		const outcome = await Promise.race([
			collect().then(chunks => ({
				type: 'resolved',
				chunks,
			})),
			delay(800).then(() => ({ type: 'timeout' as const })),
		]);
		expect(outcome.type).toBe('resolved');
	});

	test('multiple iterators complete under burst output with slow secondary consumer', async () => {
	// Windows PTY spawns are ~5-8s each on CI, and setInterval(fn, 0)
	// fires slower through ConPTY, so reduce chunk count to stay within timeout.
		const chunkCount = process.platform === 'win32' ? 200 : 800;
		const subprocess = spawnNode([
			'let i = 0',
			'const id = setInterval(() => {',
			'process.stdout.write(`chunk-${i}\\n`)',
			'i += 1',
		`if (i >= ${chunkCount}) { clearInterval(id); process.exit(0); }`,
		'}, 0)',
		].join(';'));

		const collect = async (
			iterable: AsyncIterable<string>,
			perChunkDelayMs = 0,
		) => {
			let result = '';
			for await (const chunk of iterable) {
				result += chunk;
				if (perChunkDelayMs > 0) {
					await delay(perChunkDelayMs);
				}
			}
			return result;
		};

		const outcome = await Promise.race([
			Promise.all([
				collect(subprocess),
				collect(subprocess, 1),
			]).then(([fast, slow]) => ({
				type: 'resolved' as const,
				fast,
				slow,
			})),
			delay(30_000).then(() => ({ type: 'timeout' as const })),
		]);
		expect(outcome.type).toBe('resolved');
		if (outcome.type === 'resolved') {
			const lastChunk = `chunk-${chunkCount - 1}`;
			expect(outcome.fast.includes(lastChunk)).toBe(true);
			expect(outcome.slow.includes(lastChunk)).toBe(true);
		}
	});

	test('Symbol.asyncDispose terminates a running process', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		await delay(30);
		await subprocess[Symbol.asyncDispose]();

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
	});

	test('kill and resize do not throw after process exits', async () => {
		const subprocess = spawnNode("console.log('done')");
		await subprocess;

		let threw = false;
		try {
			subprocess.kill();
			subprocess.resize(120, 40);
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
	});

	// Skipped on Windows: Windows has no POSIX signals — node-pty throws
	// "Signals not supported on windows." for any signal name passed to kill()
	// (windowsTerminal.ts), so kill('NO_SUCH_SIGNAL') never reaches the process
	// termination path. The subsequent await subprocess.kill() hangs because
	// ConPTY teardown (forking conpty_console_list_agent.js, socket drain
	// timeouts, worker thread disposal) doesn't reliably trigger the exit event,
	// and un-unref()'d handles keep the event loop alive indefinitely.
	// See:
	// - https://github.com/microsoft/node-pty/issues/437
	// - https://github.com/microsoft/node-pty/issues/887
	test('kill swallows unknown signal errors', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		let threw = false;
		try {
			subprocess.kill('NO_SUCH_SIGNAL');
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		await subprocess.kill();
		await subprocess.catch(() => {});
	});

	test('resize swallows invalid dimension errors', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		let threw = false;
		try {
			subprocess.resize(-1, 0);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);

		await subprocess.kill();
		await subprocess.catch(() => {});
	});

	test('options.signal abort rejects with SubprocessError and cause', async () => {
		for (const reason of [new Error('spawn aborted'), 'manual stop']) {
			const controller = new AbortController();
			const subprocess = spawnNode('setInterval(() => {}, 1000)', {
				signal: controller.signal,
			});

			setTimeout(() => {
				controller.abort(reason);
			}, 30);

			const error = await subprocess.catch((error_: unknown) => error_);
			expect(error).toBeInstanceOf(SubprocessError);
			expect((error as Error).cause).toBe(reason);
		}
	});

	test('pre-aborted signal rejects promptly', async () => {
		const reason = new Error('already aborted');
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			signal: AbortSignal.abort(reason),
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).cause).toBe(reason);
	});

	test('timeout option aborts long-running subprocess', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			timeout: 40,
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).message).toContain('Subprocess aborted');
		expect(((error as Error).cause as Error).name).toBe('TimeoutError');
	});

	test('late abort does not override an already exited success', async () => {
		const controller = new AbortController();
		const subprocess = spawnNode("console.log('done')", {
			signal: controller.signal,
		});

		const result = await subprocess;
		controller.abort(new Error('late abort'));

		expect(result.exitCode).toBe(0);
	});

	test('kill terminates process via default hangup signal', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode('setInterval(() => {}, 1000)');
		await subprocess.kill();
		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe('SIGHUP');
	});

	test('signal termination sets signalName', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode('setInterval(() => {}, 1000)');
		await delay(30);
		subprocess.kill('SIGTERM');

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe('SIGTERM');
	});

	test('kill with forceKill escalates to SIGKILL when process traps initial signal', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode([
			"process.on('SIGTERM', () => {})",
			"console.log('READY')",
			'setInterval(() => {}, 1000)',
		].join(';'));

		await waitFor(subprocess, output => output.includes('READY'));
		await subprocess.kill('SIGTERM', { forceKill: 300 });

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe('SIGKILL');
	});

	test('kill with forceKill clears timer when process exits before timeout', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode([
			"console.log('READY')",
			'setInterval(() => {}, 1000)',
		].join(';'));

		await waitFor(subprocess, output => output.includes('READY'));
		const startedAt = Date.now();
		await subprocess.kill('SIGTERM', { forceKill: 5000 });
		const elapsedMs = Date.now() - startedAt;

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		// Process should exit from SIGTERM well before the 5s forceKill timeout
		expect(elapsedMs < 2000).toBe(true);
		expect((error as SubprocessError).signalName).toBe('SIGTERM');
	});

	test('kill with forceKill via options-only overload', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode([
			"process.on('SIGHUP', () => {})",
			"console.log('READY')",
			'setInterval(() => {}, 1000)',
		].join(';'));

		await waitFor(subprocess, output => output.includes('READY'));
		await subprocess.kill({ forceKill: 300 });

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe('SIGKILL');
	});

	test('non-signal non-zero exit has undefined signalName', async () => {
		const subprocess = spawnNode('process.exit(5)');
		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe(undefined);
	});

	test('result.output captures full output', async () => {
		const subprocess = spawnNode([
			"process.stdout.write('HEAD-' + 'x'.repeat(270000) + '-TAIL')",
			'process.exit(0)',
		].join(';'));

		const result = await subprocess;
		expect(result.output.includes('HEAD-')).toBe(true);
		expect(result.output.endsWith('-TAIL')).toBe(true);
	});

	test('await subprocess rejects with SubprocessError on non-zero exit', async () => {
		const subprocess = spawnNode('process.exit(2)');

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).exitCode).toBe(2);
		expect((error as SubprocessError).file).toBe(process.execPath);
		expect((error as SubprocessError).args[0]).toBe('-e');
	});

	test('reject false resolves on non-zero exit', async () => {
		const subprocess = spawnNode('process.exit(3)', { reject: false });

		const result = await subprocess;
		expect(result.exitCode).toBe(3);
		expect(result.signalName).toBe(undefined);
	});

	test('reject false resolves on signal termination with signalName', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode('setInterval(() => {}, 1000)', { reject: false });
		await subprocess.kill('SIGTERM');

		const result = await subprocess;
		expect(result.signalName).toBe('SIGTERM');
	});

	test('reject false resolves on abort', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			reject: false,
			timeout: 40,
		});

		const result = await subprocess;
		expect(result.exitCode).toBeDefined();
	});
});

// node-pty on Windows leaves background conpty agents that keep the event
// loop alive indefinitely. Force exit so CI doesn't hang after tests complete.
// https://github.com/microsoft/node-pty/issues/887
if (process.platform === 'win32') {
	process.exit(); // eslint-disable-line n/no-process-exit
}
