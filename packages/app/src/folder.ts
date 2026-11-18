/**
 * An app's folder on this computer's disk (ADR-0841, ADR-0964): its `path`
 * and the three calls that change a file. Whatever loads an app calls it
 * with one (ADR-0960): serve with the app's folder, a test with a temporary
 * directory.
 *
 * A folder has no read call. An app reads with `Bun.file`, `Bun.Glob` or
 * `node:fs` on `folder.path`, as any program does; `readText` and `filesIn`
 * below are two such reads the data handles share. What the folder adds is
 * what nothing else does:
 *
 * - A write replaces a whole file at once, so a reader never sees half of it.
 * - `edit` reads, decides and replaces a file without yielding, so two edits
 *   in one process never interleave and no lock is taken (ADR-0943).
 * - A write or delete outside `data/` and `local/` throws.
 * - A new file under `local/` is `0600`, readable by its owner alone, and
 *   `local/` ignores itself in Git (ADR-0963).
 *
 * It is a convenience, not a sandbox: an app may write with `node:fs`
 * directly, and a writer outside serve, such as an editor, is not guarded
 * against.
 */

import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Ok, type Result } from 'wellcrafted/result';

/**
 * An app's folder. Paths are relative to it, with `/` between parts; one
 * that is absolute, climbs out with `..`, reaches into `.git`, or lies
 * outside `data/` and `local/` throws.
 */
export type Folder = {
	/** The folder on disk. Read any file under it with plain file calls. */
	readonly path: string;
	/**
	 * Replace the file at `path` with `content`, making the directories it
	 * needs. The last write wins: to change a file based on what is in it,
	 * use `edit`, never a read and then `write`.
	 */
	write(path: string, content: string | Uint8Array): Promise<void>;
	/**
	 * Change the file at `path` based on its text, or `undefined` when there
	 * is no file. `decide` runs once and synchronously, and nothing else
	 * changes the file between its read and its write. It returns
	 * `Ok({ text })` to write `text`, `Ok({})` to leave the file as it was, or
	 * `Err(reason)` to refuse, and nothing is written. `edit` answers the
	 * `value` it returned, or the refusal.
	 *
	 * ```ts
	 * await folder.edit('data/2026.csv', (before = 'minutes\n') =>
	 *   Ok({ text: `${before}${minutes}\n` }),
	 * );
	 * ```
	 */
	edit<T = undefined, E extends object = never>(
		path: string,
		decide: (
			before: string | undefined,
		) => Result<{ text?: string; value?: T }, E>,
	): Promise<Result<T | undefined, E>>;
	/** Delete the file at `path`, if there is one. */
	delete(path: string): Promise<void>;
};

/**
 * Whether `path`, as `normalizePath` returns it, is in the app's `local/`,
 * which stays out of Git and on this computer.
 */
export function isUnderLocal(path: string): boolean {
	return path.startsWith('local/');
}

/**
 * `path` as a folder takes it: `./a//b.md` is `a/b.md`. Throws for an empty,
 * absolute, or climbing path, and for one inside `.git`.
 */
export function normalizePath(path: string): string {
	const parts = path.split('/').filter((part) => part !== '' && part !== '.');
	if (path.startsWith('/') || path.includes('\\'))
		throw new Error(`${JSON.stringify(path)} is not a relative path`);
	if (parts.length === 0) throw new Error('a path is needed');
	if (parts.includes('..'))
		throw new Error(`${JSON.stringify(path)} climbs out of the folder`);
	if (parts[0] === '.git')
		throw new Error(`${JSON.stringify(path)} is inside .git`);
	return parts.join('/');
}

/** `path` normalized, or a throw when it lies outside `data/` and `local/`. */
function writable(path: string) {
	const normal = normalizePath(path);
	if (!normal.startsWith('data/') && !isUnderLocal(normal))
		throw new Error(
			`${path} is outside data/ and local/, and an action writes only there`,
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
 * becomes app data.
 */
export async function filesIn(root: string, relative: string) {
	let current = root;
	for (const part of relative.split('/')) {
		current = join(current, part);
		const entry = lstatSync(current, { throwIfNoEntry: false });
		if (!entry?.isDirectory()) return [];
	}
	const names: string[] = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
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

/** What `local/.gitignore` holds: everything in `local/`, itself included. */
const IGNORE_ALL = '*\n';

/** The folder at `dir`, its calls changing files on disk. */
export function folderOnDisk(dir: string): Folder {
	const owner = { recursive: true, mode: 0o700 } as const;
	const temp = join(dir, 'local', '.tmp');
	/**
	 * Replace the file at `normal` with `bytes` at once. The bytes go to a
	 * file in `local/.tmp/` and are renamed over the target, so a commit made
	 * meanwhile finds nothing unfinished under `data/`. A file that is
	 * replaced keeps its mode. A new file under `local/` is `0600` from
	 * before it has its name, and a new directory there is `0700`; one
	 * already there keeps its mode.
	 *
	 * Each write makes `local/.tmp/` if it is missing. When that makes
	 * `local/` itself, it also writes `local/.gitignore`, so `local/` stays
	 * out of Git whatever the root `.gitignore` says (ADR-0963).
	 */
	function put(normal: string, bytes: Uint8Array) {
		if (mkdirSync(join(dir, 'local'), owner) !== undefined)
			writeFileSync(join(dir, 'local', '.gitignore'), IGNORE_ALL);
		mkdirSync(temp, owner);
		const target = join(dir, normal);
		mkdirSync(
			dirname(target),
			isUnderLocal(normal) ? owner : { recursive: true },
		);
		const found = statSync(target, { throwIfNoEntry: false });
		const kept = found === undefined ? undefined : found.mode & 0o7777;
		const mode = kept ?? (isUnderLocal(normal) ? 0o600 : 0o666);
		const held = join(temp, randomUUID());
		try {
			writeFileSync(held, bytes, { mode });
			// The umask narrows a new file's mode; a kept mode is exact.
			if (kept !== undefined) chmodSync(held, kept);
			renameSync(held, target);
		} catch (error) {
			rmSync(held, { force: true });
			throw error;
		}
	}
	return {
		path: dir,
		async write(path, content) {
			put(
				writable(path),
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content,
			);
		},
		// Read, decide, and replace with no await between them: that is what
		// keeps two edits in this process from interleaving.
		async edit(path, decide) {
			const normal = writable(path);
			const before = readNow(join(dir, normal));
			const result = decide(
				before === undefined ? undefined : new TextDecoder().decode(before),
			);
			if (result.data === null) return result;
			const { text, value } = result.data;
			if (text !== undefined) {
				const bytes = new TextEncoder().encode(text);
				// Decoding drops a byte order mark, so compare the original bytes.
				if (!sameBytes(before, bytes)) put(normal, bytes);
			}
			return Ok(value);
		},
		async delete(path) {
			// Not rm with force: under Bun it answers a directory with another error.
			try {
				await unlink(join(dir, writable(path)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
				throw error;
			}
		},
	};
}
