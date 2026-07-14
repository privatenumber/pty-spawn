import { describe } from 'manten';

describe('pty-spawn', async () => {
	await Promise.all([
		import('./specs/spawn.ts'),
		import('./specs/subprocess.ts'),
		import('./specs/wait-for.ts'),
		import('./specs/pty-backend.ts'),
	]);
});
