/** Find the Epicenter for this process and read its marker. */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMarkdown } from '@epicenter/app';

export const ROOT_MARKER = 'EPICENTER.md';
const OLD_MARKER = 'epicenter.root.json';
export const DEFAULT_PORT = 4747;

export type EpicenterRoot = {
	folder: string;
	port: number;
	public?: { url: string; port: number };
};

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
		if (
			existsSync(join(folder, ROOT_MARKER)) ||
			existsSync(join(folder, OLD_MARKER))
		)
			return folder;
		const parent = dirname(folder);
		if (parent === folder) return undefined;
		folder = parent;
	}
}

function validPort(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 65535
	);
}

export function oldMarkerStep(folder: string): string {
	const old = join(folder, OLD_MARKER);
	let port = DEFAULT_PORT;
	try {
		const value: unknown = JSON.parse(readFileSync(old, 'utf8'));
		if (
			typeof value === 'object' &&
			value !== null &&
			'port' in value &&
			validPort(value.port)
		)
			port = value.port;
	} catch {}
	return `write ${ROOT_MARKER} with port: ${port}, then delete ${OLD_MARKER}`;
}

function readRoot(folder: string): EpicenterRoot {
	const marker = join(folder, ROOT_MARKER);
	let text: string;
	try {
		text = readFileSync(marker, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw new RootUsageError(`${marker} cannot be read`);
		const old = join(folder, OLD_MARKER);
		if (existsSync(old)) {
			throw new RootUsageError(
				`${old} is an old Epicenter marker; ${ROOT_MARKER} is needed`,
				oldMarkerStep(folder),
			);
		}
		throw new RootUsageError(
			`There is no ${ROOT_MARKER} in ${folder}`,
			`epicenter init ${folder}`,
		);
	}
	const read = readMarkdown(text);
	if (!read.writable || (text.startsWith('---') && read.body === text))
		throw new RootUsageError(`${marker} has invalid front matter`);
	const fields = read.fields;
	for (const field of Object.keys(fields))
		if (!['port', 'public', 'publicPort'].includes(field))
			throw new RootUsageError(`${marker} has unknown field ${field}`);
	const port = Object.hasOwn(fields, 'port') ? fields.port : DEFAULT_PORT;
	if (!validPort(port)) throw new RootUsageError(`${marker} has invalid port`);
	const publicUrl = fields.public;
	const publicPort = fields.publicPort;
	if ((publicUrl === undefined) !== (publicPort === undefined))
		throw new RootUsageError(
			`${marker} requires public and publicPort together`,
		);
	if (publicUrl !== undefined) {
		if (typeof publicUrl !== 'string')
			throw new RootUsageError(
				`${marker} has invalid public: use an https URL`,
			);
		let url: URL;
		try {
			url = new URL(publicUrl);
		} catch {
			throw new RootUsageError(
				`${marker} has invalid public: use an https URL`,
			);
		}
		if (url.protocol !== 'https:')
			throw new RootUsageError(
				`${marker} has invalid public: use an https URL`,
			);
		// MCP is at `/` and the sign-in at `/.sign-in`, so the address is an origin.
		if (
			url.pathname !== '/' ||
			url.search !== '' ||
			url.hash !== '' ||
			url.username !== '' ||
			url.password !== ''
		)
			throw new RootUsageError(
				`${marker} has invalid public: use an https origin with no path, such as https://host:10000/`,
			);
		if (!validPort(publicPort))
			throw new RootUsageError(`${marker} has invalid publicPort`);
		if (publicPort === port)
			throw new RootUsageError(`${marker} has publicPort equal to port`);
		return { folder, port, public: { url: publicUrl, port: publicPort } };
	}
	return { folder, port };
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
