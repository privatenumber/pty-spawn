import { setTimeout as delay } from 'node:timers/promises';
import {
	describe, expect, onTestFail, skip, test,
} from 'manten';
import { spawnNode } from '../utils/spawn-node.ts';
import {
	SubprocessError,
	waitFor,
} from '#pty-spawn';

describe('Subprocess', () => {
	test('output accumulates synchronously', async () => {
		const subprocess = spawnNode("console.log('hello from pty')");

		expect(subprocess.output).toBe('');

		await waitFor(subprocess, output => output.includes('hello from pty'));
		expect(subprocess.output).toContain('hello from pty');

		await subprocess;
	}, { retry: 2 });

	test('is async iterable', async () => {
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

	test('iterator started after exit completes immediately', async ({ signal }) => {
		const startedAt = performance.now();
		const serializeError = (error: unknown) => error instanceof Error
			? {
				name: error.name,
				message: error.message,
				stack: error.stack,
			}
			: error;
		const logState = (phase: string, details: Record<string, unknown> = {}) => {
			console.log('[iterator-debug]', JSON.stringify({
				phase,
				elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
				signalAborted: signal.aborted,
				signalReason: serializeError(signal.reason),
				activeResources: process.getActiveResourcesInfo(),
				...details,
			}));
		};

		onTestFail(error => logState('test-failed', {
			error: serializeError(error),
		}));
		signal.addEventListener('abort', () => {
			logState('signal-aborted');
		}, { once: true });
		logState('test-start', {
			platform: process.platform,
			architecture: process.arch,
			node: process.version,
		});

		const subprocess = spawnNode("console.log('done')", { signal });
		logState('spawn-returned', { pid: subprocess.pid });
		void subprocess.then(
			result => logState('subprocess-resolved', {
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				output: result.output,
			}),
			error => logState('subprocess-rejected', {
				error: serializeError(error),
				output: subprocess.output,
			}),
		);

		logState('subprocess-await-start');
		const result = await subprocess;
		logState('subprocess-await-end', {
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			output: result.output,
		});

		logState('iterator-start');
		let chunks = 0;
		for await (const _chunk of subprocess) {
			chunks += 1;
		}
		logState('iterator-end', { chunks });
		expect(chunks).toBe(0);
	}, 800);

	test('supports multiple iterators under burst output with a slow consumer', async ({ signal }) => {
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
		].join(';'), { signal });

		const collect = async (
			iterable: AsyncIterable<string>,
			perChunkDelayMs = 0,
		) => {
			let result = '';
			for await (const chunk of iterable) {
				result += chunk;
				if (perChunkDelayMs > 0) {
					await delay(perChunkDelayMs, undefined, { signal });
				}
			}
			return result;
		};

		const [fast, slow] = await Promise.all([
			collect(subprocess),
			collect(subprocess, 1),
		]);
		const lastChunk = `chunk-${chunkCount - 1}`;
		expect(fast.includes(lastChunk)).toBe(true);
		expect(slow.includes(lastChunk)).toBe(true);
	}, 30_000);

	test('Symbol.asyncDispose terminates a running process', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)');

		await delay(30);
		await subprocess[Symbol.asyncDispose]();

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
	});

	test('control methods do not throw after exit', async () => {
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

	test('kill uses the default hangup signal', async () => {
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

	test('forceKill escalates when the process traps the initial signal', async () => {
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

	test('forceKill clears its timer when the process exits first', async () => {
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
		// Process should exit from SIGTERM well before the 5s forceKill timeout.
		expect(elapsedMs < 2000).toBe(true);
		expect((error as SubprocessError).signalName).toBe('SIGTERM');
	});

	test('kill supports the options-only forceKill overload', async () => {
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
});
