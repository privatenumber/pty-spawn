import nodePty, { type IPty } from 'node-pty';
import type { HostMessage } from './pty-host-types.ts';

let pty: IPty | undefined;

process.on('message', (message: HostMessage) => {
	switch (message.type) {
		case 'spawn': {
			pty = nodePty.spawn(message.file, message.args, message.options);
			pty.onData((data) => {
				try {
					process.send!({
						type: 'data',
						data,
					});
				} catch {}
			});
			pty.onExit((event) => {
				try {
					process.send!(
						{
							type: 'exit',
							exitCode: event.exitCode,
							signal: event.signal,
						},
						// eslint-disable-next-line n/no-process-exit
						() => process.exit(),
					);
				} catch {
					// eslint-disable-next-line n/no-process-exit
					process.exit();
				}
			});

			break;
		}
		case 'write': {
			try {
				pty?.write(message.data);
			} catch {}

			break;
		}
		case 'kill': {
			try {
				pty?.kill();
			} catch {}

			break;
		}
		case 'resize': {
			try {
				pty?.resize(message.cols, message.rows);
			} catch {}

			break;
		}
		// no default
	}
});

process.on('disconnect', () => {
	try {
		pty?.kill();
	} catch {}

	// eslint-disable-next-line n/no-process-exit
	process.exit();
});

process.on('uncaughtException', (error) => {
	if (error.message === 'Signals not supported on windows.' || error.message === 'AttachConsole failed') {
		return;
	}

	// eslint-disable-next-line n/no-process-exit
	process.exit(1);
});
