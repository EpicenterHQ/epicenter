/**
 * Find the Epicenter for this process and read its marker, `EPICENTER.md`
 * (ADR-0868): a note for people whose optional front matter says the port
 * `serve` listens on and, with `public` and `publicPort`, the public address
 * a tunnel reaches and the port it targets (ADR-0871).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMarkdown } from '@epicenter/app';

export const MARKER = 'EPICENTER.md';
export const DEFAULT_PORT = 4747;

export type EpicenterRoot = {
	folder: string;
	/** The port `serve` listens on: the marker's, else 4747. */
	port: number;
	/**
	 * The public address, an https origin, and the port on `127.0.0.1` a
	 * tunnel to it targets; absent for an Epicenter reached only on the
	 * tailnet (ADR-0871).
	 */
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

/**
 * Whether `folder` holds `EPICENTER.md`, by its exact name; `false` for a
 * folder that cannot be listed. A case-insensitive disk opens `Epicenter.md`
 * as `EPICENTER.md`, so the name is looked up in the folder's listing rather
 * than opened.
 */
export function isMarked(folder: string): boolean {
	try {
		return readdirSync(folder).includes(MARKER);
	} catch {
		return false;
	}
}

/** The nearest folder at or above `start` that is marked as an Epicenter. */
export function ancestorWithMarker(start: string): string | undefined {
	let folder = start;
	for (;;) {
		if (isMarked(folder)) return folder;
		const parent = dirname(folder);
		if (parent === folder) return undefined;
		folder = parent;
	}
}

function isPort(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= 65535
	);
}

/**
 * Whether `value` is an https origin and nothing more: MCP is at `/` and the
 * sign-in at `/.sign-in`, so a path, query, or credentials would never be
 * reached (ADR-0871).
 */
function isPublicOrigin(value: unknown): value is string {
	if (typeof value !== 'string' || !URL.canParse(value)) return false;
	const url = new URL(value);
	return (
		url.protocol === 'https:' &&
		url.pathname === '/' &&
		url.search === '' &&
		url.hash === '' &&
		url.username === '' &&
		url.password === ''
	);
}

/** What is wrong with the marker's front matter, one line each, quoting each value. */
function markerProblems(fields: Record<string, unknown>): string[] {
	const { port, public: publicUrl, publicPort, ...rest } = fields;
	const problems: string[] = [];
	if (port !== undefined && !isPort(port))
		problems.push(
			`port: ${JSON.stringify(port)} is not a whole number from 0 to 65535`,
		);
	if (publicUrl !== undefined && !isPublicOrigin(publicUrl))
		problems.push(
			`public: ${JSON.stringify(publicUrl)} is not an https origin with no path, such as https://host:10000`,
		);
	if (publicPort !== undefined && !isPort(publicPort))
		problems.push(
			`publicPort: ${JSON.stringify(publicPort)} is not a whole number from 0 to 65535`,
		);
	else if (publicPort !== undefined && publicPort === (port ?? DEFAULT_PORT))
		problems.push(
			`publicPort: ${publicPort} is also the port; the public listener needs a port of its own`,
		);
	if ((publicUrl === undefined) !== (publicPort === undefined))
		problems.push('public and publicPort come together: give both or neither');
	problems.push(
		...Object.keys(rest).map(
			(key) =>
				`${key} is not a field; the fields are port, public, and publicPort`,
		),
	);
	return problems;
}

function readRoot(folder: string): EpicenterRoot {
	if (!isMarked(folder))
		throw new RootUsageError(
			`There is no ${MARKER} in ${folder}`,
			`epicenter init ${folder}`,
		);
	const marker = join(folder, MARKER);
	// Decoded as an app's files are, which drops a byte order mark an editor saved.
	const read = readMarkdown(new TextDecoder().decode(readFileSync(marker)));
	const problems = read.writable
		? markerProblems(read.fields)
		: ['its front matter is neither key: <JSON> lines nor YAML'];
	if (problems.length)
		throw new RootUsageError(
			problems.map((problem) => `${marker}: ${problem}`).join('\n'),
		);
	const {
		port,
		public: publicUrl,
		publicPort,
	} = read.fields as {
		port?: number;
		public?: string;
		publicPort?: number;
	};
	return {
		folder,
		port: port ?? DEFAULT_PORT,
		...(publicUrl !== undefined && publicPort !== undefined
			? { public: { url: new URL(publicUrl).origin, port: publicPort } }
			: {}),
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
