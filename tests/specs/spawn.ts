import {
	describe, expect, skip, test,
} from 'manten';
import {
	defaultWindow,
	spawnNode,
} from '../utils/spawn-node.ts';
import {
	spawn,
	SubprocessError,
} from '#pty-spawn';

describe('spawn', () => {
	test('resolves with output', async () => {
		const subprocess = spawnNode("console.log('hello from pty')");

		const result = await subprocess;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('hello from pty');
	}, { retry: 2 });

	test('returns metadata and output', async () => {
		const subprocess = spawnNode("process.stdout.write('meta')");

		expect(typeof subprocess.pid).toBe('number');

		const result = await subprocess;
		expect(result.output).toContain('meta');
		expect(result.file).toBe(process.execPath);
		expect(result.args[0]).toBe('-e');
		expect(typeof result.durationMs).toBe('number');
		expect(result.durationMs >= 0).toBe(true);
	}, { retry: 2 });

	test('preserves edge-case arguments verbatim', async () => {
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

	test('supports the options-only overload', async () => {
		const subprocess = spawn(process.execPath, {
			window: defaultWindow,
			timeout: 40,
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).message).toContain('Subprocess aborted');
	});

	test('throws for an invalid timeout', () => {
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

	test('rejects with SubprocessError and the abort cause', async () => {
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

	test('rejects promptly for a pre-aborted signal', async () => {
		const reason = new Error('already aborted');
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			signal: AbortSignal.abort(reason),
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).cause).toBe(reason);
	});

	test('aborts a long-running subprocess on timeout', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			timeout: 40,
		});

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as Error).message).toContain('Subprocess aborted');
		expect(((error as Error).cause as Error).name).toBe('TimeoutError');
	});

	test('does not let a late abort override an exited success', async () => {
		const controller = new AbortController();
		const subprocess = spawnNode("console.log('done')", {
			signal: controller.signal,
		});

		const result = await subprocess;
		controller.abort(new Error('late abort'));

		expect(result.exitCode).toBe(0);
	});

	test('leaves signalName undefined for a non-signal exit', async () => {
		const subprocess = spawnNode('process.exit(5)');
		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).signalName).toBe(undefined);
	});

	test('captures full output', async () => {
		const subprocess = spawnNode([
			"process.stdout.write('HEAD-' + 'x'.repeat(270000) + '-TAIL')",
			'process.exit(0)',
		].join(';'));

		const result = await subprocess;
		expect(result.output.includes('HEAD-')).toBe(true);
		expect(result.output.endsWith('-TAIL')).toBe(true);
	});

	test('rejects with SubprocessError on a non-zero exit', async () => {
		const subprocess = spawnNode('process.exit(2)');

		const error = await subprocess.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SubprocessError);
		expect((error as SubprocessError).exitCode).toBe(2);
		expect((error as SubprocessError).file).toBe(process.execPath);
		expect((error as SubprocessError).args[0]).toBe('-e');
	});

	test('resolves on a non-zero exit when reject is false', async () => {
		const subprocess = spawnNode('process.exit(3)', { reject: false });

		const result = await subprocess;
		expect(result.exitCode).toBe(3);
		expect(result.signalName).toBe(undefined);
	});

	test('resolves with signalName on a signal when reject is false', async () => {
		if (process.platform === 'win32') {
			skip('Signals not supported on Windows');
		}

		const subprocess = spawnNode('setInterval(() => {}, 1000)', { reject: false });
		await subprocess.kill('SIGTERM');

		const result = await subprocess;
		expect(result.signalName).toBe('SIGTERM');
	});

	test('resolves on abort when reject is false', async () => {
		const subprocess = spawnNode('setInterval(() => {}, 1000)', {
			reject: false,
			timeout: 40,
		});

		const result = await subprocess;
		expect(result.exitCode).toBeDefined();
	});
});
