import type { IPtyForkOptions } from 'node-pty';

export type HostMessage =
	| {
		type: 'spawn';
		file: string;
		args: string[];
		options: IPtyForkOptions;
	}
	| {
		type: 'write';
		data: string;
	}
	| {
		type: 'kill';
	}
	| {
		type: 'resize';
		cols: number;
		rows: number;
	};

export type HostEvent =
	| {
		type: 'data';
		data: string;
	}
	| {
		type: 'exit';
		exitCode: number;
		signal?: number;
	};
