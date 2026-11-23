/**
 * The file calls a data handle makes. Every one is synchronous, so a handle
 * reads, decides and replaces a file with no `await` in between, and two
 * requests serve runs at once never interleave on one file.
 *
 * A write replaces a whole file at once, so a reader never sees half of it.
 */

import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
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

/** The bytes of the file at `path`, or `undefined` when there is none. */
export const readBytes = (path: string) =>
	unlessMissing(() => readFileSync(path));

/**
 * The names of the files and links directly in `folder`, sorted; none when
 * the folder is missing.
 */
export function filesIn(folder: string) {
	const entries =
		unlessMissing(() => readdirSync(folder, { withFileTypes: true })) ?? [];
	return entries
		.filter((entry) => entry.isFile() || entry.isSymbolicLink())
		.map((entry) => entry.name)
		.sort();
}

/**
 * Make `home`'s `.epicenter/` ready: there, readable by its owner alone
 * (0700), with a `.gitignore` that keeps it out of Git whatever the root
 * `.gitignore` says, and with `tmp/` for writes in progress. Answers its path.
 */
export function prepareEpicenter(home: string) {
	const folder = join(home, '.epicenter');
	mkdirSync(join(folder, 'tmp'), { recursive: true });
	chmodSync(folder, 0o700);
	const ignore = join(folder, '.gitignore');
	if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
	return folder;
}

/**
 * Replace the file at `target` with `bytes` at once: they go to a file in
 * `temp`, on the same disk, and are renamed over it.
 */
export function replaceAt(target: string, bytes: Uint8Array, temp: string) {
	mkdirSync(temp, { recursive: true });
	mkdirSync(dirname(target), { recursive: true });
	const held = join(temp, randomUUID());
	try {
		writeFileSync(held, bytes);
		renameSync(held, target);
	} catch (error) {
		rmSync(held, { force: true });
		throw error;
	}
}

/**
 * Replace the file at `path` under `home`. The bytes wait in
 * `.epicenter/tmp/`, so a commit made meanwhile finds nothing unfinished
 * under `data/`.
 */
export const replaceFile = (home: string, path: string, bytes: Uint8Array) =>
	replaceAt(join(home, path), bytes, join(prepareEpicenter(home), 'tmp'));

/** Delete the file at `path`, answering whether there was one. */
export const removeFile = (path: string) =>
	unlessMissing(() => {
		unlinkSync(path);
		return true;
	}) ?? false;
