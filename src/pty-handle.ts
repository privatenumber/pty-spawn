import { spawn as cpSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IPtyForkOptions } from 'node-pty';
import type { HostEvent } from './pty-ipc.ts';

type ExitEvent = {
	exitCode: number;
	signal?: number;
};

type PtyHandle = {
	pid: number;
	onData: (callback: (data: string) => void) => void;
	onExit: (callback: (event: ExitEvent) => void) => void;
	kill: (signal?: string) => void;
	write: (data: string) => void;
	resize: (columns: number, rows: number) => void;
};

export const createHostedHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
	const hostScriptPath = fileURLToPath(import.meta.resolve('#pty-host'));
	const child = cpSpawn(process.execPath, ['--no-warnings', hostScriptPath], {
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		windowsHide: true,
	});

	child.send({
		type: 'spawn',
		file,
		args,
		options,
	});

	let dataCallback: (data: string) => void;
	let exitCallback: (event: ExitEvent) => void;
	let exitFired = false;

	const fireExit = (event: ExitEvent) => {
		if (exitFired) {
			return;
		}
		exitFired = true;
		exitCallback(event);
	};

	child.on('message', (message: HostEvent) => {
		if (message.type === 'data') {
			dataCallback(message.data);
		} else if (message.type === 'exit') {
			fireExit({
				exitCode: message.exitCode,
				signal: message.signal,
			});
		}
	});

	child.on('error', () => {
		fireExit({ exitCode: 1 });
	});

	child.on('exit', (code) => {
		fireExit({ exitCode: code ?? 1 });
	});

	return {
		pid: child.pid ?? 0,
		onData: (callback) => {
			dataCallback = callback;
		},
		onExit: (callback) => {
			exitCallback = callback;
		},
		kill: () => {
			try {
				child.send({ type: 'kill' });
			} catch {}
			const timer = setTimeout(() => {
				try {
					child.kill();
				} catch {}
			}, 2000);
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

const nodePty = process.platform === 'win32'
	? undefined
	: await import('node-pty');

export const createPtyHandle = process.platform === 'win32'
	? createHostedHandle
	: nodePty!.spawn;
