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
 */
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises';
import { basename } from 'node:path';
import { hashBytes } from './capture.js';
import type { DirectoryPrimitives, EntryKind } from './directory-handle.js';
import { UnexpectedTarget } from './errors.js';
import type { Expectation } from './opfs-store.js';

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
			const name =
				kind === 'file' || kind === 'directory'
					? basename(await realpath(path))
					: undefined;
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
		await writeFile(path, bytes, { flag: options?.createNew ? 'wx' : 'w' });
	},
	async rename(from, to, expected) {
		await check(to, expected);
		await rename(from, to);
	},
	async remove(path, options) {
		if (options?.expected !== undefined) await check(path, options.expected);
		if (options?.recursive) await rm(path, { recursive: true });
		else if ((await lstat(path)).isDirectory()) await rmdir(path);
		else await rm(path);
	},
	async mkdir(path) {
		await mkdir(path, { recursive: true });
	},
};
