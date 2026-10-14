/**
 * Directory primitives over `node:fs`, for Bun and Node: tests, scripts, and
 * any host that can reach the disk itself.
 */
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	writeFile,
} from 'node:fs/promises';
import type { DirectoryPrimitives, EntryKind } from './directory-handle.js';

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

export const nodeDirectoryPrimitives: DirectoryPrimitives = {
	async readDir(path) {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
	},
	async lstat(path) {
		try {
			const stats = await lstat(path);
			return { kind: kindOf(stats), size: stats.size, mode: stats.mode };
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
	async rename(from, to) {
		await rename(from, to);
	},
	async remove(path, options) {
		if (options?.recursive) await rm(path, { recursive: true });
		else if ((await lstat(path)).isDirectory()) await rmdir(path);
		else await rm(path);
	},
	async mkdir(path) {
		await mkdir(path, { recursive: true });
	},
};
