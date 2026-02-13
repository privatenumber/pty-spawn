import { spawn as cpSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { IPtyForkOptions } from 'node-pty';

export type PtyHandle = {
	pid: number;
	onData: (callback: (data: string) => void) => void;
	onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => void;
	kill: (signal?: string) => void;
	write: (data: string) => void;
	resize: (columns: number, rows: number) => void;
};

const buildHostScript = (nodePtyPath: string) => [
	`const nodePty = require(${JSON.stringify(nodePtyPath)});`,
	'let pty;',
	"process.on('message', (msg) => {",
	"  if (msg.type === 'spawn') {",
	'    pty = nodePty.spawn(msg.file, msg.args, msg.options);',
	'    pty.onData((data) => {',
	"      try { process.send({ type: 'data', data }); } catch {}",
	'    });',
	'    pty.onExit((e) => {',
	'      try {',
	"        process.send({ type: 'exit', exitCode: e.exitCode, signal: e.signal }, () => process.exit());",
	'      } catch { process.exit(); }',
	'    });',
	"  } else if (msg.type === 'write') {",
	'    try { pty.write(msg.data); } catch {}',
	"  } else if (msg.type === 'kill') {",
	'    try { pty.kill(msg.signal); } catch {}',
	"  } else if (msg.type === 'resize') {",
	'    try { pty.resize(msg.cols, msg.rows); } catch {}',
	'  }',
	'});',
	"process.on('disconnect', () => {",
	'  if (pty) { try { pty.kill(); } catch {} }',
	'  process.exit();',
	'});',
	"process.on('uncaughtException', (error) => {",
	"  if (error.message === 'Signals not supported on windows.' || error.message === 'AttachConsole failed') return;",
	"  try { process.send({ type: 'error', message: error.message }); } catch {}",
	'  process.exit(1);',
	'});',
].join('\n');

const createDirectHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
	const esmRequire = createRequire(import.meta.url);
	const nodePty: typeof import('node-pty') = esmRequire('node-pty');
	const pty = nodePty.spawn(file, args, options);
	return {
		pid: pty.pid,
		onData: (callback) => { pty.onData(callback); },
		onExit: (callback) => { pty.onExit(callback); },
		kill: (signal?) => { pty.kill(signal); },
		write: (data) => { pty.write(data); },
		resize: (columns, rows) => { pty.resize(columns, rows); },
	};
};

const createHostedHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
	const esmRequire = createRequire(import.meta.url);
	const nodePtyPath = esmRequire.resolve('node-pty');
	const hostScript = buildHostScript(nodePtyPath);

	const child = cpSpawn(process.execPath, ['--no-warnings', '-e', hostScript], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		windowsHide: true,
	});

	child.send({ type: 'spawn', file, args, options });

	let dataCallback: ((data: string) => void) | undefined;
	let exitCallback: ((event: { exitCode: number; signal?: number }) => void) | undefined;
	const dataBuffer: string[] = [];
	let exitEvent: { exitCode: number; signal?: number } | undefined;
	let exitFired = false;

	const fireExit = (event: { exitCode: number; signal?: number }) => {
		if (exitFired) {
			return;
		}
		exitFired = true;
		if (exitCallback) {
			exitCallback(event);
			return;
		}
		exitEvent = event;
	};

	child.on('message', (message) => {
		const msg = message as Record<string, unknown>;
		if (msg.type === 'data') {
			const data = msg.data as string;
			if (dataCallback) {
				dataCallback(data);
			} else {
				dataBuffer.push(data);
			}
		} else if (msg.type === 'exit') {
			fireExit({
				exitCode: msg.exitCode as number,
				signal: msg.signal as number | undefined,
			});
		}
	});

	child.on('exit', (code) => {
		fireExit({ exitCode: code ?? 1 });
	});

	return {
		pid: child.pid!,
		onData: (callback) => {
			dataCallback = callback;
			for (const data of dataBuffer) {
				callback(data);
			}
			dataBuffer.length = 0;
		},
		onExit: (callback) => {
			if (exitEvent) {
				callback(exitEvent);
				return;
			}
			exitCallback = callback;
		},
		kill: (signal?) => {
			try {
				child.send({ type: 'kill', signal });
			} catch {}
			const timer = setTimeout(() => {
				try { child.kill(); } catch {}
			}, 5000);
			timer.unref();
		},
		write: (data) => {
			try {
				child.send({ type: 'write', data });
			} catch {}
		},
		resize: (columns, rows) => {
			try {
				child.send({ type: 'resize', cols: columns, rows });
			} catch {}
		},
	};
};

export const createPtyHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => (
	process.platform === 'win32'
		? createHostedHandle(file, args, options)
		: createDirectHandle(file, args, options)
);
