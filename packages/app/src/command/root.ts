/**
 * Find the Epicenter a command runs in and read its marker, `EPICENTER.md`
 * (ADR-0868, ADR-0965): a note for people whose optional front matter says the port
 * `serve` listens on:
 *
 * ```yaml
 * port: 4747
 * ```
 *
 * Commands validate the marker's settings before running.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';
import { readMarkdown } from '../front-matter.ts';
import { ActionError, type NotStarted } from '../index.ts';

export const MARKER = 'EPICENTER.md';
const DEFAULT_PORT = 4747;

/** The Epicenter a command acts on, found once and passed to everything that reads it. */
export type EpicenterRoot = {
	/** Its real path. */
	folder: string;
	/** The port `serve` listens on: the marker's, else 4747. */
	port: number;
};

/**
 * Whether `folder` holds the file `EPICENTER.md`, by its exact name; `false`
 * for a folder that cannot be listed. A case-insensitive disk opens
 * `Epicenter.md` as `EPICENTER.md`, so the name is looked up in the folder's
 * listing rather than opened.
 */
function isMarked(folder: string): boolean {
	try {
		return readdirSync(folder, { withFileTypes: true }).some(
			(entry) => entry.name === MARKER && !entry.isDirectory(),
		);
	} catch {
		return false;
	}
}

/** The nearest folder at or above `start` that is marked as an Epicenter. */
function ancestorWithMarker(start: string): string | undefined {
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
		value >= 1 &&
		value <= 65535
	);
}

/** What is wrong with the marker's front matter, one line each, quoting each value. */
function markerProblems(fields: Record<string, unknown>): string[] {
	const { port, ...rest } = fields;
	const problems: string[] = [];
	if (port !== undefined && !isPort(port))
		problems.push(
			`port: ${JSON.stringify(port)} is not a whole number from 1 to 65535`,
		);
	problems.push(
		...Object.keys(rest).map(
			(key) => `${key} is not a field; the only field is port`,
		),
	);
	return problems;
}

function readRoot(folder: string): Result<EpicenterRoot, NotStarted> {
	const marker = join(folder, MARKER);
	// Decoded as an app's files are, which drops a byte order mark an editor saved.
	const read = readMarkdown(new TextDecoder().decode(readFileSync(marker)));
	const problems = read.readable
		? [
				...read.notJson.map(
					({ key, line }) => `${key} on line ${line} is not JSON`,
				),
				...markerProblems(read.fields),
			]
		: [
				'its front matter is not key: value lines between two --- lines, each key once',
			];
	if (problems.length)
		return ActionError.NotStarted({
			cause: 'usage',
			message: problems.map((problem) => `${marker}: ${problem}`).join('\n'),
		});
	const { port } = read.fields as { port?: number };
	return Ok({ folder, port: port ?? DEFAULT_PORT });
}

/**
 * The Epicenter a command run in `start` acts on, its marker read and
 * checked: the nearest folder at or above `start` that holds `EPICENTER.md`,
 * as Git finds the nearest `.git` (ADR-0965). There is no other way to choose
 * one. A command finds it once and passes it down.
 */
export function epicenterRoot(
	start = process.cwd(),
): Result<EpicenterRoot, NotStarted> {
	const folder = ancestorWithMarker(start);
	if (folder === undefined)
		return ActionError.NotStarted({
			cause: 'usage',
			message: `There is no ${MARKER} here or above; cd into your Epicenter`,
		});
	return readRoot(realpathSync(folder));
}

/** The Epicenter's optional agent guidance, sent in MCP initialize. */
export async function rootInstructions({
	folder,
}: {
	folder: string;
}): Promise<string | undefined> {
	try {
		return await readFile(join(folder, 'AGENTS.md'), 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}
