/**
 * Directory primitives over `node:fs`, for Bun and Node: tests, scripts, and
 * any host that can reach the disk itself.
 *
 * A rename or removal checks what it expects at its path and then changes
 * it: two steps, with nothing here holding the path between them. The caller
 * holds what keeps other saves out: `@epicenter/folder/bun` wraps each one in
 * the folder's save lock, the lock the desktop shell takes around its own
 * checked renames, so a Bun process's save and a window's never interleave.
 * A program that takes no save lock can still change the path in between.
 *
 * On Unix a private directory is `0700` and a private file `0600`, so no
 * other account reads what is staged in one. Windows has no such bits: a
 * directory or file made there has the access its parent passes on.
 */
import { constants } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises';
import { basename } from 'node:path';
import type {
	DirectoryPrimitives,
	EntryKind,
	Expectation,
} from './directory-primitives.js';
import { UnexpectedTarget } from './errors.js';
import { hashBytes } from './hash.js';

const kindOf = (entry: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): EntryKind =>
	entry.isFile()
		? 'file'
		: entry.isDirectory()
			? 'directory'
			: entry.isSymbolicLink()
				? 'link'
				: 'other';

/** Reject with `UnexpectedTarget` unless `path` holds what `expected` says. */
async function check(path: string, expected: Expectation): Promise<void> {
	if (expected === 'any') return;
	const found = await lstat(path).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (expected === 'absent') {
		if (found !== undefined)
			throw new UnexpectedTarget(path, { name: 'Exists' });
		return;
	}
	if (expected === 'present') {
		if (found === undefined)
			throw new UnexpectedTarget(path, { name: 'NotFound' });
		if (!found.isFile()) throw new Error(`'${path}' is not a file`);
		return;
	}
	if (!found?.isFile())
		throw new UnexpectedTarget(path, {
			name: 'Conflict',
			actualSha256: undefined,
		});
	const actualSha256 = await hashBytes(new Uint8Array(await readFile(path)));
	if (actualSha256 !== expected.sha256)
		throw new UnexpectedTarget(path, { name: 'Conflict', actualSha256 });
}

/** Whether this platform has Unix permission bits. */
const unix = process.platform !== 'win32';

/**
 * Give `staged` the permission bits of the regular file at `target`, when
 * one is there, as the desktop shell's `keep_mode` does: only the read,
 * write, and execute bits, never setuid, setgid, or sticky.
 */
async function keepMode(target: string, staged: string): Promise<void> {
	if (!unix) return;
	const existing = await lstat(target).catch((cause: { code?: string }) => {
		if (cause.code === 'ENOENT') return undefined;
		throw cause;
	});
	if (existing?.isFile()) await chmod(staged, existing.mode & 0o777);
}

/**
 * Make the directory at `path`, whose parent is there, readable only by
 * this account: made `0700`, or tightened to it when an older version left
 * it open (`0755`). Its mode is read and changed through the directory
 * opened without following a link, so a link swapped in is refused, never
 * followed and never changed. One another account owns cannot be changed,
 * and is refused.
 */
async function privateDirectory(path: string): Promise<void> {
	await mkdir(path, { mode: 0o700 }).catch((cause: { code?: string }) => {
		if (cause.code !== 'EEXIST') throw cause;
	});
	const seen = await lstat(path);
	if (!seen.isDirectory())
		throw new Error(
			`'${path}' is ${seen.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}, so nothing was staged there. Remove it, then save again.`,
		);
	if (!unix) return;
	const tightened = async () => {
		const directory = await open(
			path,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			const opened = await directory.stat();
			if (
				!opened.isDirectory() ||
				(opened.dev !== seen.dev || opened.ino !== seen.ino)
			)
				throw new Error('it changed while it was checked');
			if ((opened.mode & 0o077) === 0) return;
			await directory.chmod(0o700);
			if (((await directory.stat()).mode & 0o077) !== 0)
				throw new Error('other accounts can still open it');
		} finally {
			await directory.close();
		}
	};
	await tightened().catch((cause: unknown) => {
		throw new Error(
			`'${path}' could not be made private to this account, so nothing was staged there: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	});
}

export const nodeDirectoryPrimitives: DirectoryPrimitives = {
	async readDir(path) {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
	},
	async lstat(path) {
		try {
			const stats = await lstat(path);
			const kind = kindOf(stats);
			// `realpath` answers with the stored spelling; a link is not followed.
			// Racing a rename over the path, Bun's on Linux can answer with
			// `<name> (deleted)`, so a name it does not confirm is left out and
			// the directory store lists the parent instead.
			const asked = basename(path);
			const stored =
				kind === 'file' || kind === 'directory'
					? basename(await realpath(path))
					: undefined;
			const name = stored === asked ? stored : undefined;
			return { kind, size: stats.size, mode: stats.mode, name };
		} catch (cause) {
			if ((cause as { code?: string }).code === 'ENOENT') return undefined;
			throw cause;
		}
	},
	async readFile(path) {
		return new Uint8Array(await readFile(path));
	},
	async writeFile(path, bytes, options) {
		await writeFile(path, bytes, {
			flag: options?.createNew ? 'wx' : 'w',
			...(options?.private && { mode: 0o600 }),
		});
	},
	async rename(from, to, expected) {
		await check(to, expected);
		await keepMode(to, from);
		await rename(from, to);
	},
	async remove(path, options) {
		if (options?.expected !== undefined) await check(path, options.expected);
		if (options?.recursive) await rm(path, { recursive: true });
		else if ((await lstat(path)).isDirectory()) await rmdir(path);
		else await rm(path);
	},
	async mkdir(path, options) {
		if (options?.private) await privateDirectory(path);
		else await mkdir(path, { recursive: true });
	},
};
