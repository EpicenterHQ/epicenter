/**
 * How the data handles read and change files in a home. It is internal: an
 * app reads and writes records through its data handles, and anything else
 * with `Bun.file` or `node:fs` as any program does.
 *
 * - A write replaces a whole file at once, so a reader never sees half of it.
 * - `editFile` reads, decides and replaces a file without yielding, so two
 *   edits in one process never interleave and no lock is taken.
 * - A folder on the way to a record must be a real folder, not a link, so a
 *   write lands where `filesIn` reads, and never outside the home.
 */

import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Err, Ok, type Result } from 'wellcrafted/result';

/** The text of the file at `path`, or `undefined` when there is none. */
export async function readText(path: string) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * The first part of the folder `relative` under `home` that is there but is
 * not a real folder, such as a link; undefined when every part present is
 * one. A missing part is fine: a write makes it.
 */
function notAFolder(home: string, relative: string) {
	const parts = relative.split('/');
	for (let end = 1; end <= parts.length; end++) {
		const part = parts.slice(0, end).join('/');
		const entry = lstatSync(join(home, part), { throwIfNoEntry: false });
		if (entry === undefined) return undefined;
		if (!entry.isDirectory()) return part;
	}
	return undefined;
}

/**
 * The names of the files directly in the folder `relative` under `home`, a
 * link to a file counting as one, sorted. None when the folder is missing or
 * any part of `relative` is a link, so a linked folder never becomes records.
 */
export function filesIn(home: string, relative: string) {
	const folder = join(home, relative);
	if (
		notAFolder(home, relative) !== undefined ||
		!lstatSync(folder, { throwIfNoEntry: false })
	)
		return [];
	const names: string[] = [];
	for (const entry of readdirSync(folder, { withFileTypes: true })) {
		if (entry.isFile()) names.push(entry.name);
		// A broken link has no target, so it is no file.
		else if (
			entry.isSymbolicLink() &&
			statSync(join(folder, entry.name), { throwIfNoEntry: false })?.isFile()
		)
			names.push(entry.name);
	}
	return names.sort();
}

/** Throw when the folder holding `path` under `home` is reached through a link. */
function refuseLinked(home: string, path: string) {
	const linked = notAFolder(home, dirname(path));
	if (linked !== undefined)
		throw new Error(
			`${linked} is a link or a file, not a folder; records are written only to real folders under data/`,
		);
}

/** The bytes at `target` now, or `undefined` when there is no file. */
function readNow(target: string) {
	try {
		return readFileSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Whether two reads found the same file: the same bytes, or no file both times. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined) {
	return a === undefined || b === undefined
		? a === b
		: Buffer.from(a).equals(b);
}

/**
 * Replace the file at `path` under `home` with `bytes` at once. The bytes go
 * to a file in `local/.tmp/` and are renamed over the target, so a commit
 * made meanwhile finds nothing unfinished under `data/`. A file that is
 * replaced keeps its mode. When the write makes `local/`, it also writes
 * `local/.gitignore`, so the temporary files stay out of Git whatever the
 * root `.gitignore` says.
 */
function put(home: string, path: string, bytes: Uint8Array) {
	if (mkdirSync(join(home, 'local'), { recursive: true }) !== undefined)
		writeFileSync(join(home, 'local', '.gitignore'), '*\n');
	const temp = join(home, 'local', '.tmp');
	mkdirSync(temp, { recursive: true });
	const target = join(home, path);
	mkdirSync(dirname(target), { recursive: true });
	const found = statSync(target, { throwIfNoEntry: false });
	const kept = found === undefined ? undefined : found.mode & 0o7777;
	const held = join(temp, randomUUID());
	try {
		writeFileSync(held, bytes, { mode: kept ?? 0o666 });
		// The umask narrows a new file's mode; a kept mode is exact.
		if (kept !== undefined) chmodSync(held, kept);
		renameSync(held, target);
	} catch (error) {
		rmSync(held, { force: true });
		throw error;
	}
}

/**
 * Change the file at `path` under `home` based on its text, or `undefined`
 * when there is no file. `decide` runs once and synchronously, and nothing
 * else in this process changes the file between its read and its write. It
 * returns `Ok({ text, value })` to write `text`, `Ok({ value })` to leave the
 * file as it was, or `Err(reason)` to refuse, and nothing is written.
 */
export async function editFile<T, E>(
	home: string,
	path: string,
	decide: (
		before: string | undefined,
	) => Result<{ text?: string; value: T }, E>,
): Promise<Result<T, E>> {
	refuseLinked(home, path);
	const before = readNow(join(home, path));
	const result = decide(
		before === undefined ? undefined : new TextDecoder().decode(before),
	);
	if (result.error !== null) return result as Err<E>;
	const { text, value } = result.data as { text?: string; value: T };
	if (text !== undefined) {
		const bytes = new TextEncoder().encode(text);
		// Decoding drops a byte order mark, so compare the original bytes.
		if (!sameBytes(before, bytes)) put(home, path, bytes);
	}
	return Ok(value);
}

/** Delete the file at `path` under `home`, answering whether there was one. */
export async function deleteFile(home: string, path: string) {
	refuseLinked(home, path);
	// Not rm with force: under Bun it answers a directory with another error.
	try {
		await unlink(join(home, path));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
