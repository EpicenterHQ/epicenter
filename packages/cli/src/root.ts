/**
 * Find the Epicenter for this process and read its marker, `EPICENTER.md`
 * (ADR-0868): a note for people whose optional front matter says the port
 * `serve` listens on, and who may approve a client at a public address.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readMarkdown } from '@epicenter/app';

export const MARKER = 'EPICENTER.md';
/** The marker before `EPICENTER.md`: a folder marked only by it is refused, naming the step that replaces it. */
const OLD_MARKER = 'epicenter.root.json';
export const DEFAULT_PORT = 4747;
/** The ports Tailscale Funnel publishes, one of which `public` names. */
const PUBLIC_PORTS = [443, 8443, 10000] as const;
type PublicPort = (typeof PUBLIC_PORTS)[number];

export type EpicenterRoot = {
	folder: string;
	/** The port `serve` listens on: the marker's, else 4747. */
	port: number;
	/** The tailnet logins that may approve a client at the public address (ADR-0871). */
	owners?: string[];
	/** The Funnel port that makes this Epicenter public (ADR-0871). */
	public?: PublicPort;
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
 * The marker `folder` holds, by its exact name: `EPICENTER.md`, else the
 * marker before it, else `undefined`, also for a folder that cannot be
 * listed. A case-insensitive disk opens `Epicenter.md` as `EPICENTER.md`, so
 * the name is looked up in the folder's listing rather than opened.
 */
function markerIn(folder: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(folder);
	} catch {
		return undefined;
	}
	return [MARKER, OLD_MARKER].find((name) => names.includes(name));
}

/** Whether `folder` is marked as an Epicenter, by `EPICENTER.md` or the marker before it. */
export function isMarked(folder: string): boolean {
	return markerIn(folder) !== undefined;
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

/** The port the old marker in `folder` named, or 4747 when it named none or cannot be read. */
function oldPort(folder: string): number {
	try {
		const { port } = JSON.parse(readFileSync(join(folder, OLD_MARKER), 'utf8'));
		if (Number.isInteger(port)) return port;
	} catch {}
	return DEFAULT_PORT;
}

/** What is wrong with the marker's front matter, one line each, quoting each value. */
function markerProblems(fields: Record<string, unknown>): string[] {
	const problems: string[] = [];
	const { port, owners, public: published, ...rest } = fields;
	const quoted = (key: string, value: unknown) =>
		`${key}: ${JSON.stringify(value)}`;
	if (
		port !== undefined &&
		!(
			typeof port === 'number' &&
			Number.isInteger(port) &&
			port >= 0 &&
			port <= 65535
		)
	)
		problems.push(
			`${quoted('port', port)} is not a whole number from 0 to 65535`,
		);
	if (
		owners !== undefined &&
		!(
			Array.isArray(owners) &&
			owners.every((owner) => typeof owner === 'string' && owner !== '')
		)
	)
		problems.push(`${quoted('owners', owners)} is not a list of logins`);
	if (
		published !== undefined &&
		!PUBLIC_PORTS.includes(published as PublicPort)
	)
		problems.push(
			`${quoted('public', published)} is not 443, 8443, or 10000, the ports Funnel publishes`,
		);
	for (const key of Object.keys(rest))
		problems.push(
			`${key} is not a field; the fields are port, owners, and public`,
		);
	return problems;
}

/** The refusal for a folder marked only by the marker before `EPICENTER.md`, its step in the message. */
export function oldMarkerRefusal(folder: string) {
	return `${folder} is marked by ${OLD_MARKER}, which epicenter no longer reads; write ${MARKER} with port: ${oldPort(folder)}, then delete ${OLD_MARKER}`;
}

/** Whether `folder` is marked by the marker before `EPICENTER.md` alone. */
export function isMarkedOnlyByOld(folder: string): boolean {
	return markerIn(folder) === OLD_MARKER;
}

function readRoot(folder: string): EpicenterRoot {
	const found = markerIn(folder);
	if (found === OLD_MARKER) throw new RootUsageError(oldMarkerRefusal(folder));
	if (found === undefined)
		throw new RootUsageError(
			`There is no ${MARKER} in ${folder}`,
			`epicenter init ${folder}`,
		);
	const marker = join(folder, MARKER);
	// A byte order mark an editor saved before the front matter is not part of it.
	const read = readMarkdown(
		readFileSync(marker, 'utf8').replace(/^\uFEFF/, ''),
	);
	const problems = read.writable
		? markerProblems(read.fields)
		: ['its front matter is neither key: <JSON> lines nor YAML'];
	if (problems.length)
		throw new RootUsageError(
			problems.map((problem) => `${marker}: ${problem}`).join('\n'),
		);
	const { port, owners, public: published } = read.fields;
	return {
		folder,
		port: (port as number | undefined) ?? DEFAULT_PORT,
		...(owners === undefined ? {} : { owners: owners as string[] }),
		...(published === undefined ? {} : { public: published as PublicPort }),
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
