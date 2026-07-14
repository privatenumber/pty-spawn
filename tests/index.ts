import { describe } from 'manten';

describe('pty-spawn', () => {
	import('./specs/spawn.ts');
	import('./specs/subprocess.ts');
	import('./specs/wait-for.ts');
	import('./specs/pty-backend.ts');
});
