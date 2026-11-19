/**
 * The file calls a data handle makes. Every one is synchronous, so a handle
 * reads, decides and replaces a file with no `await` in between, and two
 * requests serve runs at once never interleave on one file.
 *
 * A write replaces a whole file at once, so a reader never sees half of it.
 */

import { randomUUID } from 'node:crypto';
import {
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
 * Replace the file at `path` under `home` with `bytes` at once. The bytes go
 * to a file in `local/.tmp/` and are renamed over the target, so a commit
 * made meanwhile finds nothing unfinished under `data/`. When the write
 * makes `local/`, it also writes `local/.gitignore`, so the temporary files
 * stay out of Git whatever the root `.gitignore` says.
 */
export function replaceFile(home: string, path: string, bytes: Uint8Array) {
	if (mkdirSync(join(home, 'local'), { recursive: true }) !== undefined)
		writeFileSync(join(home, 'local', '.gitignore'), '*\n');
	const temp = join(home, 'local', '.tmp');
	mkdirSync(temp, { recursive: true });
	const target = join(home, path);
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

/** Delete the file at `path`, answering whether there was one. */
export const removeFile = (path: string) =>
	unlessMissing(() => {
		unlinkSync(path);
		return true;
	}) ?? false;
