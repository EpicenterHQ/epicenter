/**
 * How `defineData` changes files in a home. It is internal: an app reads and
 * writes records through its data handles, and anything else with
 * `Bun.file` or `node:fs` as any program does.
 *
 * - A write replaces a whole file at once, so a reader never sees half of it.
 * - `edit` reads, decides and replaces a file without yielding, so two edits
 *   in one process never interleave and no lock is taken.
 * - A write or delete outside `data/` throws.
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

/**
 * Why a folder will not take `path`, or undefined when it will: an empty,
 * absolute or climbing path, one with `\`, which Windows reads as a
 * separator, and one inside `.git`.
 */
export function pathRefusal(path: string): string | undefined {
	const parts = path.split('/').filter((part) => part !== '' && part !== '.');
	if (path.startsWith('/') || path.includes('\\'))
		return `${JSON.stringify(path)} is not a relative path`;
	if (parts.length === 0) return 'a path is needed';
	if (parts.includes('..'))
		return `${JSON.stringify(path)} climbs out of the folder`;
	if (parts[0] === '.git') return `${JSON.stringify(path)} is inside .git`;
	return undefined;
}

/** `path` normalized (`./data//a.md` is `data/a.md`), or a throw when it lies outside `data/`. */
function writable(path: string) {
	const refusal = pathRefusal(path);
	if (refusal !== undefined) throw new Error(refusal);
	const normal = path
		.split('/')
		.filter((part) => part !== '' && part !== '.')
		.join('/');
	if (!normal.startsWith('data/'))
		throw new Error(
			`${path} is outside data/, and records are written only there`,
		);
	return normal;
}

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
 * The names of the files directly in the directory `relative` under `root`,
 * a link to a file counting as one, sorted. None when the directory is
 * missing or any part of `relative` is a link, so a linked directory never
 * becomes records.
 */
export function filesIn(root: string, relative: string) {
	let current = root;
	for (const part of relative.split('/')) {
		current = join(current, part);
		const entry = lstatSync(current, { throwIfNoEntry: false });
		if (!entry?.isDirectory()) return [];
	}
	const names: string[] = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		if (entry.isFile()) names.push(entry.name);
		// A broken link has no target, so it is no file.
		else if (
			entry.isSymbolicLink() &&
			statSync(join(current, entry.name), { throwIfNoEntry: false })?.isFile()
		)
			names.push(entry.name);
	}
	return names.sort();
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

/** The calls that change files under the home at `dir`. */
export type Folder = ReturnType<typeof openFolder>;

/**
 * The home at `dir`, its calls changing files under its `data/`. Nothing
 * touches the disk until a call is made.
 */
export function openFolder(dir: string) {
	const temp = join(dir, 'local', '.tmp');
	/**
	 * Replace the file at `normal` with `bytes` at once. The bytes go to a
	 * file in `local/.tmp/` and are renamed over the target, so a commit made
	 * meanwhile finds nothing unfinished under `data/`. A file that is
	 * replaced keeps its mode. When the write makes `local/`, it also writes
	 * `local/.gitignore`, so the temporary files stay out of Git whatever the
	 * root `.gitignore` says.
	 */
	function put(normal: string, bytes: Uint8Array) {
		if (mkdirSync(join(dir, 'local'), { recursive: true }) !== undefined)
			writeFileSync(join(dir, 'local', '.gitignore'), '*\n');
		mkdirSync(temp, { recursive: true });
		const target = join(dir, normal);
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
	return {
		/** The home on disk. */
		path: dir,
		/**
		 * Change the file at `path` based on its text, or `undefined` when there
		 * is no file. `decide` runs once and synchronously, and nothing else in
		 * this process changes the file between its read and its write. It
		 * returns `Ok({ text, value })` to write `text`, `Ok({ value })` to leave
		 * the file as it was, or `Err(reason)` to refuse, and nothing is written.
		 */
		async edit<T, E>(
			path: string,
			decide: (
				before: string | undefined,
			) => Result<{ text?: string; value: T }, E>,
		): Promise<Result<T, E>> {
			const normal = writable(path);
			const before = readNow(join(dir, normal));
			const result = decide(
				before === undefined ? undefined : new TextDecoder().decode(before),
			);
			if (result.error !== null) return result as Err<E>;
			const { text, value } = result.data as { text?: string; value: T };
			if (text !== undefined) {
				const bytes = new TextEncoder().encode(text);
				// Decoding drops a byte order mark, so compare the original bytes.
				if (!sameBytes(before, bytes)) put(normal, bytes);
			}
			return Ok(value);
		},
		/** Delete the file at `path`, answering whether there was one. */
		async delete(path: string) {
			// Not rm with force: under Bun it answers a directory with another error.
			try {
				await unlink(join(dir, writable(path)));
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
				throw error;
			}
		},
	};
}
