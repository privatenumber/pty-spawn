import { setTimeout as delay } from 'node:timers/promises';
import { createPtyProcess } from '../../src/pty-bridge.ts';

const iterations = process.platform === 'win32' ? 5 : 10;

// Keep one PTY active at a time so this tests cleanup rather than concurrency limits.
for (let index = 0; index < iterations; index += 1) {
	const ptyProcess = createPtyProcess(
		process.execPath,
		['--no-warnings', '-e', "process.stdout.write('READY'); setInterval(() => {}, 1000)"],
		{
			cols: 80,
			rows: 24,
		},
	);
	const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<void>();
	let killed = false;
	let output = '';
	ptyProcess.onData((data) => {
		output += data;
		if (!killed && output.includes('READY')) {
			killed = true;
			ptyProcess.kill();
		}
	});
	ptyProcess.onExit(() => {
		resolveExit();
	});

	await Promise.race([
		exitPromise,
		delay(15_000, undefined, { ref: false }).then(() => {
			throw new Error(`PTY stress iteration ${index + 1} did not exit.`);
		}),
	]);
}
