/**
 * The file calls a data handle makes. Every one is synchronous, so a handle
 * reads, decides and replaces a file with no `await` in between, and two
 * requests serve runs at once never interleave on one file.
 *
 * - A write replaces a whole file at once, so a reader never sees half of it.
 * - A record's folder must be a real folder, not a link, so a write lands
 *   where a read looks, and never outside the home.
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
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** What `run` returns, or `undefined` when it finds no file there. */
function unlessMissing<T>(run: () => T) {
	try {
		return run();
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
export function notAFolder(home: string, relative: string) {
	const parts = relative.split('/');
	for (let end = 1; end <= parts.length; end++) {
		const part = parts.slice(0, end).join('/');
		const entry = lstatSync(join(home, part), { throwIfNoEntry: false });
		if (entry === undefined) return undefined;
		if (!entry.isDirectory()) return part;
	}
	return undefined;
}

/** The bytes of the file at `path`, or `undefined` when there is none. */
export const readBytes = (path: string) =>
	unlessMissing(() => readFileSync(path));

/**
 * The names of the files directly in `folder`, a link to a file counting as
 * one, sorted; none when the folder is missing.
 */
export function filesIn(folder: string) {
	const entries =
		unlessMissing(() => readdirSync(folder, { withFileTypes: true })) ?? [];
	return entries
		.filter(
			(entry) =>
				entry.isFile() ||
				// A broken link has no target, so it is no file.
				(entry.isSymbolicLink() &&
					statSync(join(folder, entry.name), {
						throwIfNoEntry: false,
					})?.isFile()),
		)
		.map((entry) => entry.name)
		.sort();
}

/**
 * Replace the file at `path` under `home` with `bytes` at once. The bytes go
 * to a file in `local/.tmp/` and are renamed over the target, so a commit
 * made meanwhile finds nothing unfinished under `data/`. A file that is
 * replaced keeps its mode. When the write makes `local/`, it also writes
 * `local/.gitignore`, so the temporary files stay out of Git whatever the
 * root `.gitignore` says.
 */
export function replaceFile(home: string, path: string, bytes: Uint8Array) {
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

/** Delete the file at `path`, answering whether there was one. */
export const removeFile = (path: string) =>
	unlessMissing(() => {
		unlinkSync(path);
		return true;
	}) ?? false;
