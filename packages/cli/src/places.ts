/**
 * The disk places an action receives (ADR-0841): its data folder and a cache
 * it can rebuild. Writes replace a whole file at once; listing avoids Git,
 * dependencies, and directory links so those trees never become app data.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { type Dirent, mkdirSync } from 'node:fs';
import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { type Cache, type Folder, normalizePath } from '@epicenter/app';

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function diskFolder(
	dir: string,
	dirty: ReadonlySet<string> = new Set(),
): Folder & { clear(): Promise<void> } {
	const pathOf = (path: string) => join(dir, normalizePath(path));
	const writable = (path: string) => {
		const normalized = normalizePath(path);
		if (dirty.has(normalized))
			throw new Error(
				`${normalized} has changes you have not committed; commit or discard them first`,
			);
		return join(dir, normalized);
	};
	async function readBytes(path: string) {
		try {
			return await readFile(pathOf(path));
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	}
	async function writeBytes(path: string, bytes: Uint8Array) {
		const target = writable(path);
		await mkdir(dirname(target), { recursive: true });
		const temp = join(
			dirname(target),
			`.${basename(target)}.${randomUUID()}.tmp`,
		);
		try {
			await writeFile(temp, bytes);
			await rename(temp, target);
		} finally {
			await rm(temp, { force: true });
		}
	}
	return {
		path: dir,
		readBytes,
		async read(path) {
			const bytes = await readBytes(path);
			return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
		},
		writeBytes,
		async write(path, text) {
			await writeBytes(path, new TextEncoder().encode(text));
		},
		async remove(path) {
			try {
				await unlink(writable(path));
			} catch (error) {
				if (!missing(error)) throw error;
			}
		},
		async list(subdir) {
			const found: string[] = [];
			async function walk(relative: string) {
				let entries: Dirent[];
				try {
					entries = await readdir(join(dir, relative), { withFileTypes: true });
				} catch (error) {
					if (missing(error)) return;
					throw error;
				}
				for (const entry of entries) {
					const path = relative ? `${relative}/${entry.name}` : entry.name;
					if (entry.name === '.git' || entry.name === 'node_modules') continue;
					if (entry.isDirectory()) await walk(path);
					else if (entry.isFile()) found.push(path);
					else if (entry.isSymbolicLink()) {
						try {
							if ((await stat(join(dir, path))).isFile()) found.push(path);
						} catch (error) {
							if (!missing(error)) throw error;
						}
					}
				}
			}
			const relative = subdir === undefined ? '' : normalizePath(subdir);
			if (
				relative
					.split('/')
					.some((part) => part === '.git' || part === 'node_modules')
			)
				return [];
			if (relative) {
				let current = dir;
				for (const part of relative.split('/')) {
					current = join(current, part);
					try {
						if ((await lstat(current)).isSymbolicLink()) return [];
					} catch (error) {
						if (missing(error)) return [];
						throw error;
					}
				}
			}
			await walk(relative);
			return found.sort();
		},
		async clear() {
			try {
				for (const name of await readdir(dir))
					await rm(join(dir, name), { recursive: true, force: true });
			} catch (error) {
				if (!missing(error)) throw error;
			}
		},
	};
}

/** Give an action disk-backed data methods without a way to clear the whole folder. */
export function folderOnDisk(dir: string, dirty?: ReadonlySet<string>): Folder {
	const { clear: _, ...folder } = diskFolder(dir, dirty);
	return folder;
}

/** Give an action a lazily created cache, including disposable SQLite databases. */
export function cacheOnDisk(dir: string): Cache {
	return {
		...diskFolder(dir),
		sqlite(name) {
			if (!/^[a-z][a-z0-9-]*$/.test(name))
				throw new Error(
					`${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`,
				);
			// SQLite opens synchronously, so its parent must exist before the constructor.
			mkdirSync(dir, { recursive: true });
			return new Database(join(dir, `${name}.sqlite`));
		},
	};
}

/** Locate this device's app caches independently of the app home. */
export function cacheRoot(): string {
	return (
		process.env.EPICENTER_CACHE_HOME ??
		join(homedir(), 'Library/Caches/so.epicenter.apps')
	);
}
