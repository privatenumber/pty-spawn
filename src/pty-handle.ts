import { spawn as cpSpawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { IPtyForkOptions } from 'node-pty';
import type { HostEvent } from './pty-host-types.ts';

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

// On Windows, node-pty leaves un-unref'd handles (Worker, sockets, drain
// timeouts) after kill(), preventing Node from exiting.
// https://github.com/microsoft/node-pty/issues/437
// Isolating node-pty in a child process lets us force-exit the child, keeping
// the parent's event loop clean.
export const createHostedHandle = (
	file: string,
	args: string[],
	options: IPtyForkOptions,
): PtyHandle => {
	const hostScriptPath = fileURLToPath(import.meta.resolve('#pty-host'));
	// stdio fds: 0=stdin, 1=stdout, 2=stderr (all ignored), 3=ipc
	// All communication goes through IPC; child's stdout/stderr are suppressed
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

	// Guard against multiple exit sources: IPC 'exit' message, child 'exit'
	// event, and child 'error' event can all fire — only the first one counts
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

	// child.send() both throws AND emits 'error' when IPC channel closes.
	// Without this handler, the error is unhandled and crashes the parent.
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
			// Ask the child to close ConPTY gracefully via IPC
			try {
				child.send({ type: 'kill' });
			} catch {}
			// Safety net: force-kill the child if it doesn't exit in time.
			// ref: false so this timer doesn't keep the event loop alive.
			setTimeout(2000, undefined, { ref: false }).then(() => {
				try {
					child.kill();
				} catch {}
			}).catch(() => {});
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

// On non-Windows, use node-pty directly (no overhead). The ternary
// short-circuits so node-pty is never imported on Windows.
const nodePty = process.platform === 'win32'
	? undefined
	: await import('node-pty');

export const createPtyHandle = process.platform === 'win32'
	? createHostedHandle
	: nodePty!.spawn;
