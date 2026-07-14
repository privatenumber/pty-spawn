import { spawn as spawnChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
	describe, expect, skip, test,
} from 'manten';
import {
	createHostedPtyProcess,
	createNodePtyProcess,
	type ExitEvent,
	type PtyProcess,
	type PtyProcessFactory,
} from '../../src/pty-bridge.ts';

const defaultOptions = {
	cols: 80,
	rows: 24,
} as const;

type PtyCommand = string | {
	file: string;
	args: string[];
};

const observePtyProcess = (
	createPtyProcess: PtyProcessFactory,
	command: PtyCommand,
	onData?: (ptyProcess: PtyProcess, output: string) => void,
) => {
	const file = typeof command === 'string' ? process.execPath : command.file;
	const args = typeof command === 'string'
		? ['--no-warnings', '-e', command]
		: command.args;
	const ptyProcess = createPtyProcess(
		file,
		args,
		defaultOptions,
	);
	const state: {
		output: string;
		exitEvents: ExitEvent[];
	} = {
		output: '',
		exitEvents: [],
	};
	const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<ExitEvent>();

	ptyProcess.onData((data) => {
		state.output += data;
		onData?.(ptyProcess, state.output);
	});
	ptyProcess.onExit((event) => {
		state.exitEvents.push(event);
		resolveExit(event);
	});

	return {
		ptyProcess,
		state,
		exitPromise,
	};
};

const ptyBackendContract = (
	name: string,
	createPtyProcess: PtyProcessFactory,
	skipReason?: string,
) => describe(name, () => {
	if (skipReason) {
		skip(skipReason);
	}

	test('captures complete output from an immediate exit', async () => {
		const expectedLines = Array.from(
			{ length: 2048 },
			(_, index) => `LINE-${index.toString().padStart(4, '0')}:${'x'.repeat(48)}`,
		);
		const { ptyProcess, state, exitPromise } = observePtyProcess(
			createPtyProcess,
			[
				'for (let index = 0; index < 2048; index += 1) {',
				"process.stdout.write(`LINE-${index.toString().padStart(4, '0')}:${'x'.repeat(48)}\\n`)",
				'}',
				'process.exitCode = 42',
			].join(';'),
		);

		const exitEvent = await exitPromise;
		const matches = state.output.match(/LINE-\d{4}:x{48}/g);
		const observedLines = matches ? new Set(matches) : new Set<string>();
		const missingLines = expectedLines.filter(line => !observedLines.has(line));

		expect(ptyProcess.pid > 0).toBe(true);
		expect(exitEvent.exitCode).toBe(42);
		expect({
			lineCount: observedLines.size,
			missingLines: missingLines.slice(0, 10),
		}).toEqual({
			lineCount: expectedLines.length,
			missingLines: [],
		});
	}, {
		timeout: 30_000,
	});

	test('writes to the PTY', async () => {
		if (process.platform === 'win32') {
			skip('ConPTY stdin delivery is unreliable on Windows');
		}

		let wroteInput = false;
		const { state, exitPromise } = observePtyProcess(
			createPtyProcess,
			[
				"process.stdout.write('READY')",
				'process.stdin.resume()',
				"process.stdin.once('data', data => {",
				"process.stdout.write('GOT:' + data.toString().trim())",
				'process.exit(0)',
				'})',
			].join(';'),
			(ptyProcess, output) => {
				if (!wroteInput && output.includes('READY')) {
					wroteInput = true;
					ptyProcess.write('ping\n');
				}
			},
		);

		const exitEvent = await exitPromise;
		expect(exitEvent.exitCode).toBe(0);
		expect(state.output).toContain('GOT:ping');
	}, {
		timeout: 30_000,
	});

	test('resizes the PTY', async () => {
		const resizeCommand: PtyCommand = process.platform === 'win32'
			? {
				file: 'powershell.exe',
				args: [
					'-NoLogo',
					'-NoProfile',
					'-Command',
					[
						'$deadline = (Get-Date).AddSeconds(5)',
						'do {',
						'$size = $Host.UI.RawUI.WindowSize',
						'Write-Output "SIZE:$($size.Width)x$($size.Height)"',
						'if ($size.Width -eq 100 -and $size.Height -eq 40) { exit 0 }',
						'Start-Sleep -Milliseconds 50',
						'} while ((Get-Date) -lt $deadline)',
						'exit 2',
					].join(';'),
				],
			}
			: [
				'const reportSize = () => {',
				"console.log('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows)",
				'if (process.stdout.columns === 100 && process.stdout.rows === 40) process.exit(0)',
				'}',
				'reportSize()',
				'setInterval(reportSize, 50)',
				'setTimeout(() => process.exit(2), 5000)',
			].join(';');
		let resized = false;
		const { state, exitPromise } = observePtyProcess(
			createPtyProcess,
			resizeCommand,
			(ptyProcess, output) => {
				if (!resized && output.includes('SIZE:80x24')) {
					resized = true;
					ptyProcess.resize(100, 40);
				}
			},
		);

		const exitEvent = await exitPromise;
		expect(exitEvent.exitCode).toBe(0);
		expect(state.output).toContain('SIZE:100x40');
	}, {
		timeout: 30_000,
	});

	test('kill terminates and emits exit exactly once', async () => {
		let killed = false;
		const { state, exitPromise } = observePtyProcess(
			createPtyProcess,
			"process.stdout.write('READY'); setInterval(() => {}, 1000)",
			(ptyProcess, output) => {
				if (!killed && output.includes('READY')) {
					killed = true;
					ptyProcess.kill();
				}
			},
		);

		const exitEvent = await exitPromise;
		await delay(200);

		expect(typeof exitEvent.exitCode).toBe('number');
		expect(state.exitEvents).toHaveLength(1);
	}, {
		timeout: 30_000,
	});

	test('control methods are safe after exit', async () => {
		const { ptyProcess, exitPromise } = observePtyProcess(
			createPtyProcess,
			'process.exit(0)',
		);
		await exitPromise;

		expect(() => {
			ptyProcess.write('data');
			ptyProcess.resize(100, 40);
			ptyProcess.kill();
		}).not.toThrow();
	}, {
		timeout: 30_000,
	});
}, {
	parallel: false,
	timeout: 120_000,
});

describe('PTY backend', () => {
	ptyBackendContract(
		'node-pty direct',
		createNodePtyProcess,
		process.platform === 'win32'
			? 'Direct node-pty cleanup is unreliable on Windows'
			: undefined,
	);
	ptyBackendContract('hosted node-pty', createHostedPtyProcess);

	test('selected backend releases the parent event loop after repeated kills', async () => {
		const stressScriptPath = fileURLToPath(new URL(
			'../fixtures/pty-backend-stress.ts',
			import.meta.url,
		));
		const child = spawnChildProcess(process.execPath, [stressScriptPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			timeout: 85_000,
		});
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		let output = '';
		let errorOutput = '';
		child.stdout.on('data', (data: string) => {
			output += data;
		});
		child.stderr.on('data', (data: string) => {
			errorOutput += data;
		});

		const [exitCode, signalName] = await once(child, 'close');
		expect({
			exitCode,
			signalName,
			output,
			errorOutput,
		}).toEqual({
			exitCode: 0,
			signalName: null,
			output: '',
			errorOutput: '',
		});
	}, 90_000);
});
