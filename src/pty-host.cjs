/* eslint-disable */
const nodePty = require('node-pty');
let pty;
process.on('message', (msg) => {
	if (msg.type === 'spawn') {
		pty = nodePty.spawn(msg.file, msg.args, msg.options);
		pty.onData((data) => {
			try { process.send({ type: 'data', data }); } catch {}
		});
		pty.onExit((e) => {
			try {
				process.send({ type: 'exit', exitCode: e.exitCode, signal: e.signal }, () => process.exit());
			} catch { process.exit(); }
		});
	} else if (msg.type === 'write') {
		try { pty.write(msg.data); } catch {}
	} else if (msg.type === 'kill') {
		try { pty.kill(msg.signal); } catch {}
	} else if (msg.type === 'resize') {
		try { pty.resize(msg.cols, msg.rows); } catch {}
	}
});
process.on('disconnect', () => {
	if (pty) { try { pty.kill(); } catch {} }
	process.exit();
});
process.on('uncaughtException', (error) => {
	if (error.message === 'Signals not supported on windows.' || error.message === 'AttachConsole failed') return;
	process.exit(1);
});
