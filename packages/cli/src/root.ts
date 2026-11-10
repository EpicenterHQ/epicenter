/** Find the Epicenter for this process and read its written-once identity. */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ROOT_MARKER = 'epicenter.root.json';
export const DEFAULT_PORT = 4747;

export type EpicenterRoot = { folder: string; id: string; port: number };

export class RootUsageError extends Error {
	constructor(
		message: string,
		public next?: string,
	) {
		super(message);
	}
}

/** Expand a person's `~` and make a folder path absolute. */
export function folderPath(path: string): string {
	return resolve(
		path === '~'
			? homedir()
			: path.startsWith('~/')
				? join(homedir(), path.slice(2))
				: path,
	);
}

export function ancestorWithMarker(start: string): string | undefined {
	let folder = start;
	for (;;) {
		if (existsSync(join(folder, ROOT_MARKER))) return folder;
		const parent = dirname(folder);
		if (parent === folder) return undefined;
		folder = parent;
	}
}

function readRoot(folder: string): EpicenterRoot {
	const marker = join(folder, ROOT_MARKER);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(marker, 'utf8'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			throw new RootUsageError(
				`There is no ${ROOT_MARKER} in ${folder}`,
				`epicenter init ${folder}`,
			);
		throw new RootUsageError(`${marker} is not readable JSON`);
	}
	if (
		typeof value !== 'object' ||
		value === null ||
		!('id' in value) ||
		typeof value.id !== 'string' ||
		value.id.length === 0 ||
		('port' in value &&
			(typeof value.port !== 'number' ||
				!Number.isInteger(value.port) ||
				value.port < 0 ||
				value.port > 65535))
	)
		throw new RootUsageError(
			`${marker} must have an id and an optional port from 0 to 65535`,
		);
	return {
		folder,
		id: value.id,
		port: 'port' in value ? (value.port as number) : DEFAULT_PORT,
	};
}

let selected: EpicenterRoot | undefined;

/** The nearest marked ancestor wins, then EPICENTER_ROOT, then $HOME/Epicenter. */
export function epicenterRoot(): EpicenterRoot {
	if (selected) return selected;
	const folder =
		ancestorWithMarker(process.cwd()) ??
		(process.env.EPICENTER_ROOT !== undefined
			? folderPath(process.env.EPICENTER_ROOT)
			: join(homedir(), 'Epicenter'));
	selected = readRoot(folder);
	return selected;
}

export function epicenterDir(): string {
	return epicenterRoot().folder;
}

/** A folder's optional agent guidance, sent in MCP initialize. */
export async function rootInstructions(): Promise<string | undefined> {
	try {
		return await readFile(join(epicenterDir(), 'AGENTS.md'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}
