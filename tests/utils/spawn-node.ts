import {
	spawn,
	type Options,
} from '#pty-spawn';

export const defaultWindow = {
	cols: 80,
	rows: 24,
} as const;

export const spawnNode = (script: string, options: Options = {}) => spawn(
	process.execPath,
	['-e', script],
	{
		window: defaultWindow,
		...options,
	},
);
