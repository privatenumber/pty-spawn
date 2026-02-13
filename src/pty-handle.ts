import { spawn as cpSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { IPtyForkOptions } from 'node-pty';

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

const hostScriptPath = fileURLToPath(import.meta.resolve('#pty-host'));

const createHostedHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
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

	child.on('message', (message) => {
		const message_ = message as Record<string, unknown>;
		if (message_.type === 'data') {
			dataCallback(message_.data as string);
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
		},
		onExit: (callback) => {
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

const nodePty = process.platform === 'win32'
	? undefined
	: await import('node-pty');

export const createPtyHandle = process.platform === 'win32'
	? createHostedHandle
	: nodePty!.spawn;
