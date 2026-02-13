import { spawn as cpSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { IPty, IPtyForkOptions } from 'node-pty';
import hostScript from './pty-host.cjs' with { type: 'text' };

type ExitEvent = {
	exitCode: number;
	signal?: number;
};

export type PtyHandle = {
	pid: number;
	onData: (callback: (data: string) => void) => void;
	onExit: (callback: (event: ExitEvent) => void) => void;
	kill: (signal?: string) => void;
	write: (data: string) => void;
	resize: (columns: number, rows: number) => void;
};

const createDirectHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
	const esmRequire = createRequire(import.meta.url);
	const nodePty = esmRequire('node-pty') as {
		spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
	};
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

	const child = cpSpawn(process.execPath, ['--no-warnings', '-e', hostScript], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		windowsHide: true,
	});

	child.send({
		type: 'spawn',
		nodePtyPath,
		file,
		args,
		options,
	});

	let dataCallback: ((data: string) => void) | undefined;
	let exitCallback: ((event: ExitEvent) => void) | undefined;
	const dataBuffer: string[] = [];
	let exitEvent: ExitEvent | undefined;
	let exitFired = false;

	const fireExit = (event: ExitEvent) => {
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
		const message_ = message as Record<string, unknown>;
		if (message_.type === 'data') {
			const data = message_.data as string;
			if (dataCallback) {
				dataCallback(data);
			} else {
				dataBuffer.push(data);
			}
		} else if (message_.type === 'exit') {
			fireExit({
				exitCode: message_.exitCode as number,
				signal: message_.signal as number | undefined,
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
				child.send({
					type: 'kill',
					signal,
				});
			} catch {}
			const timer = setTimeout(() => {
				try {
					child.kill();
				} catch {}
			}, 5000);
			timer.unref();
		},
		write: (data) => {
			try {
				child.send({
					type: 'write',
					data,
				});
			} catch {}
		},
		resize: (columns, rows) => {
			try {
				child.send({
					type: 'resize',
					cols: columns,
					rows,
				});
			} catch {}
		},
	};
};

export const createPtyHandle = process.platform === 'win32'
	? createHostedHandle
	: createDirectHandle;
