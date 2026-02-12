import type {
	Subprocess,
} from './spawn.ts';

export type WaitForOptions = {
	signal?: AbortSignal;
};

export type WaitForPredicate = (
	output: string,
) => boolean | Promise<boolean>;

export const waitFor = async (
	subprocess: Subprocess,
	predicate: WaitForPredicate,
	{
		signal,
	}: WaitForOptions = {},
): Promise<void> => {
	if (signal?.aborted) {
		throw signal.reason;
	}

	let output = '';
	const iterator = subprocess[Symbol.asyncIterator]();

	let removeAbortListener: (() => void) | undefined;
	const abortPromise = signal
		? new Promise<never>((_resolve, reject) => {
			const handler = () => reject(signal.reason);
			signal.addEventListener('abort', handler, { once: true });
			removeAbortListener = () => signal.removeEventListener('abort', handler);
		})
		: undefined;

	// Prevent unhandled rejection if abort fires outside Promise.race
	abortPromise?.catch(() => {});

	try {
		while (true) {
			const next = abortPromise
				? await Promise.race([iterator.next(), abortPromise])
				: await iterator.next();

			if (next.done) {
				break;
			}

			output += next.value;
			if (await predicate(output)) {
				return;
			}

			if (signal?.aborted) {
				throw signal.reason;
			}
		}
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason;
		}
		throw error;
	} finally {
		removeAbortListener?.();
	}

	// Iterator ended = process exited
	const exitCode = await subprocess
		.then(result => result.exitCode)
		.catch((error: unknown) => (error as { exitCode?: number }).exitCode);

	throw new Error(
		`Process exited with code ${exitCode} before waitFor predicate was satisfied.\nLast output: ${JSON.stringify(output.slice(-200))}`,
	);
};
