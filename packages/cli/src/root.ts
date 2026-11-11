/**
 * Find the Epicenter for this process and read its marker, `EPICENTER.md`
 * (ADR-0868): a note for people whose optional front matter says the port
 * `serve` listens on and, in a `connectors` block, the public address
 * connectors reach (ADR-0881):
 *
 * ```yaml
 * port: 4747
 * connectors:
 *   url: https://studio.tail0f84e1.ts.net:10000      the public address a tunnel serves
 *   port: 4757                                       where on 127.0.0.1 the tunnel forwards
 *   tailnet: https://studio.tail0f84e1.ts.net:4747   this listener on the tailnet, where approvals happen
 * ```
 *
 * The marker is read when a command starts, and a field that is wrong stops
 * it with a line naming that field: a person or an agent edits this file by
 * hand, and what it says decides what reaches the internet.
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
	/** Where connectors reach this Epicenter; absent when nothing does. */
	connectors?: Connectors;
};

/** The `connectors` block, each address an https origin (ADR-0881). */
export type Connectors = {
	/** The public address a tunnel serves, for connectors only. */
	url: string;
	/** The port on `127.0.0.1` the tunnel forwards to. */
	port: number;
	/** The private listener as the tailnet reaches it, where a connector is approved. */
	tailnet: string;
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
 * approval page at `/.allow`, so a path, query, or credentials would never be
 * reached.
 */
function isHttpsOrigin(value: unknown): value is string {
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

/**
 * What is wrong with the `connectors` block, one line each. The block is
 * whole or absent, so no rule has to say its fields come together.
 */
function connectorsProblems(value: unknown, port: unknown): string[] {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return [
			`connectors: ${JSON.stringify(value)} is not a block of url, port, and tailnet`,
		];
	const {
		url,
		port: publicPort,
		tailnet,
		...rest
	} = value as Record<string, unknown>;
	const problems: string[] = [];
	/** `field: <value> is not <what>`, or `field is missing: <what>`. */
	const wrong = (field: string, value: unknown, what: string) =>
		value === undefined
			? `connectors.${field} is missing: ${what}`
			: `connectors.${field}: ${JSON.stringify(value)} is not ${what}`;
	if (!isHttpsOrigin(url))
		problems.push(
			wrong(
				'url',
				url,
				'an https origin with no path, such as https://host:10000',
			),
		);
	if (!isPort(publicPort))
		problems.push(wrong('port', publicPort, 'a whole number from 0 to 65535'));
	else if (publicPort === (port ?? DEFAULT_PORT))
		problems.push(
			`connectors.port: ${publicPort} is also the port; the public listener needs a port of its own`,
		);
	if (!isHttpsOrigin(tailnet))
		problems.push(
			wrong(
				'tailnet',
				tailnet,
				'an https origin with no path, such as https://host.tailnet.ts.net:4747',
			),
		);
	else if (
		isHttpsOrigin(url) &&
		new URL(url).origin === new URL(tailnet).origin
	)
		problems.push(
			'connectors.tailnet is the public url; a connector is approved only where the tailnet reaches',
		);
	problems.push(
		...Object.keys(rest).map(
			(key) =>
				`connectors.${key} is not a field; the fields are url, port, and tailnet`,
		),
	);
	return problems;
}

/** What is wrong with the marker's front matter, one line each, quoting each value. */
function markerProblems(fields: Record<string, unknown>): string[] {
	const { port, connectors, ...rest } = fields;
	const problems: string[] = [];
	if (port !== undefined && !isPort(port))
		problems.push(
			`port: ${JSON.stringify(port)} is not a whole number from 0 to 65535`,
		);
	if (connectors !== undefined)
		problems.push(...connectorsProblems(connectors, port));
	problems.push(
		...Object.keys(rest).map(
			(key) => `${key} is not a field; the fields are port and connectors`,
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
	const { port, connectors } = read.fields as {
		port?: number;
		connectors?: Connectors;
	};
	return {
		folder,
		port: port ?? DEFAULT_PORT,
		...(connectors
			? {
					connectors: {
						url: new URL(connectors.url).origin,
						port: connectors.port,
						tailnet: new URL(connectors.tailnet).origin,
					},
				}
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
