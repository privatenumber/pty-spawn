import { EventEmitter, on } from 'node:events';
import { constants as osConstants } from 'node:os';
import type { IPtyForkOptions } from 'node-pty';
import { createPtyProcess } from './pty-bridge.ts';

export type Result = {
	output: string;
	exitCode: number;
	signalName?: string;
	file: string;
	args: readonly string[];
	durationMs: number;
};

export type WindowOptions = {
	cols?: number;
	rows?: number;
};

export type Options = Omit<IPtyForkOptions, 'cols' | 'rows'> & {
	window?: WindowOptions;
	signal?: AbortSignal;
	timeout?: number;
	reject?: boolean;
};

const getSignalName = (signal: number | undefined) => {
	if (signal === undefined) {
		return undefined;
	}

	for (const [name, number] of Object.entries(osConstants.signals)) {
		if (number === signal) {
			return name;
		}
	}

	return undefined;
};

const createAbortSignal = (
	userSignal: AbortSignal | undefined,
	timeout: number,
) => {
	if (!userSignal && timeout <= 0) {
		return undefined;
	}

	if (!userSignal) {
		return AbortSignal.timeout(timeout);
	}

	if (timeout <= 0) {
		return userSignal;
	}

	return AbortSignal.any([userSignal, AbortSignal.timeout(timeout)]);
};

export class SubprocessError extends Error implements Result {
	output!: string;

	exitCode!: number;

	signalName?: string;

	file!: string;

	args!: readonly string[];

	durationMs!: number;

	constructor(
		message: string,
		{ cause, ...result }: Result & {
			cause?: unknown;
		},
	) {
		super(message, { cause });
		this.name = 'SubprocessError';
		Object.assign(this, result);
	}
}

export type KillOptions = {
	forceKill?: number;
};

export type Subprocess = Promise<Result> & {
	readonly pid: number;
	readonly output: string;
	kill: {
		(signal?: string, options?: KillOptions): Promise<void>;
		(options?: KillOptions): Promise<void>;
	};
	resize: (cols: number, rows: number) => void;
	stdin: {
		write: (data: string) => void;
	};
	[Symbol.asyncIterator]: () => AsyncIterator<string>;
	[Symbol.asyncDispose]: () => Promise<void>;
};

export function spawn(file: string, args: readonly string[], options?: Options): Subprocess;
export function spawn(file: string, options?: Options): Subprocess;
// eslint-disable-next-line pvtnbr/prefer-arrow-functions
export function spawn(
	file: string,
	argsOrOptions: readonly string[] | Options = [],
	maybeOptions: Options = {},
): Subprocess {
	const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
	const options = Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions as Options;

	const {
		window,
		signal: userSignal,
		timeout = 0,
		reject: shouldReject = true,
		...ptyOptions
	} = options;
	if (!Number.isFinite(timeout) || timeout < 0) {
		throw new TypeError('options.timeout must be a non-negative finite number.');
	}

	const startedAt = Date.now();
	const ptyProcess = createPtyProcess(file, args, {
		...ptyOptions,
		cols: window?.cols,
		rows: window?.rows,
	});
	const signal = createAbortSignal(userSignal, timeout);

	// eslint-disable-next-line unicorn/prefer-event-target
	const emitter = new EventEmitter();
	let output = '';
	let exitCode: number | undefined;
	let exitSignalName: string | undefined;
	let lastDataAt = 0;
	let settled = false;
	let abortedBeforeExit = false;
	let settleQuietTimer: NodeJS.Timeout | undefined;
	let settleMaxTimer: NodeJS.Timeout | undefined;

	const quietMs = 50;
	const maxMs = 3000;

	let resolveResult: (value: Result) => void;
	let rejectResult: (reason: unknown) => void;
	const resultPromise = new Promise<Result>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});

	const safeKill = (killSignal?: string) => {
		try {
			ptyProcess.kill(killSignal);
		} catch {}
	};

	const settle = (code: number) => {
		if (settled) {
			return;
		}
		settled = true;
		if (settleQuietTimer) {
			clearTimeout(settleQuietTimer);
		}
		if (settleMaxTimer) {
			clearTimeout(settleMaxTimer);
		}
		signal?.removeEventListener('abort', onAbort);

		const result: Result = {
			output,
			exitCode: code,
			signalName: exitSignalName,
			file,
			args,
			durationMs: Date.now() - startedAt,
		};

		if (!shouldReject) {
			resolveResult(result);
			return;
		}

		if (signal?.aborted && abortedBeforeExit) {
			rejectResult(new SubprocessError('Subprocess aborted.', {
				...result,
				cause: signal.reason,
			}));
			return;
		}

		if (code !== 0 || exitSignalName) {
			const message = exitSignalName
				? `Subprocess terminated by signal ${exitSignalName}.`
				: `Subprocess exited with code ${code}.`;
			rejectResult(new SubprocessError(message, result));
			return;
		}

		resolveResult(result);
	};

	const scheduleSettle = () => {
		if (exitCode === undefined) {
			return;
		}

		const elapsedSinceLastData = lastDataAt === 0
			? 0
			: (Date.now() - lastDataAt);
		const quietDelayMs = Math.max(0, quietMs - elapsedSinceLastData);

		if (settleQuietTimer) {
			clearTimeout(settleQuietTimer);
		}

		const code = exitCode;
		settleQuietTimer = setTimeout(() => {
			settle(code);
		}, quietDelayMs);
	};

	const onAbort = () => {
		if (exitCode === undefined) {
			abortedBeforeExit = true;
		}
		safeKill();
	};

	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener('abort', onAbort, { once: true });
	}

	ptyProcess.onData((data) => {
		lastDataAt = Date.now();
		output += data;
		emitter.emit('data', data);

		if (exitCode !== undefined) {
			scheduleSettle();
		}
	});

	ptyProcess.onExit(({ exitCode: nextExitCode, signal: exitSignal }) => {
		exitCode = nextExitCode;
		exitSignalName = getSignalName(exitSignal);
		emitter.emit('exit', nextExitCode);
		scheduleSettle();
		settleMaxTimer = setTimeout(() => {
			settle(nextExitCode);
		}, maxMs);
	});
	const iterateOutput = async function* iterateOutput() {
		if (exitCode !== undefined) {
			await resultPromise;
			return;
		}

		const iteratorAbort = new AbortController();
		const onIteratorExit = () => {
			iteratorAbort.abort();
		};

		emitter.once('exit', onIteratorExit);
		if (exitCode !== undefined) {
			iteratorAbort.abort();
		}
		try {
			for await (const [chunk] of on(emitter, 'data', { signal: iteratorAbort.signal })) {
				yield chunk as string;
			}
		} catch (error) {
			if (!iteratorAbort.signal.aborted) {
				throw error;
			}
		} finally {
			emitter.off('exit', onIteratorExit);
			await resultPromise;
		}
	};

	const kill = async (
		signalOrOptions?: string | KillOptions,
		killOptions?: KillOptions,
	) => {
		const killSignal = typeof signalOrOptions === 'string' ? signalOrOptions : undefined;
		const { forceKill } = typeof signalOrOptions === 'object'
			? signalOrOptions
			: (killOptions ?? {});
		safeKill(killSignal);

		const forceKillTimer = forceKill === undefined
			? undefined
			: setTimeout(() => safeKill('SIGKILL'), forceKill);

		await resultPromise.catch(() => {});

		if (forceKillTimer) {
			clearTimeout(forceKillTimer);
		}
	};
	const subprocess = Object.assign(resultPromise, {
		pid: ptyProcess.pid,
		kill,
		resize: (cols: number, rows: number) => {
			try {
				ptyProcess.resize(cols, rows);
			} catch {}
		},
		stdin: {
			write: (data: string) => {
				ptyProcess.write(data);
			},
		},
		[Symbol.asyncIterator]: iterateOutput,
		[Symbol.asyncDispose]: kill,
	}) as unknown as Subprocess;
	Object.defineProperty(subprocess, 'output', {
		get: () => output,
		enumerable: true,
		configurable: true,
	});

	return subprocess;
}
