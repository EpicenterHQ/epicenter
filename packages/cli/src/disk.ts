/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0850). It is a
 * convenience, not a sandbox: paths are normalized and `.git` is refused, and
 * otherwise a write is a write, recorded nowhere. Writes replace a whole file
 * at once. `commit` runs Git from the folder. Listing avoids Git,
 * dependencies, and directory links so those trees never become app data.
 */

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
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
import { dirname, join } from 'node:path';
import { type Folder, normalizePath } from '@epicenter/app';
import { commitFolder } from './git.ts';

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The app's folder at `dir`, its methods reading and writing the disk. */
export function folderOnDisk(dir: string): Folder {
	const pathOf = (path: string) => join(dir, normalizePath(path));
	async function readBytes(path: string) {
		try {
			return await readFile(pathOf(path));
		} catch (error) {
			if (missing(error)) return undefined;
			throw error;
		}
	}
	async function writeBytes(path: string, bytes: Uint8Array) {
		const target = pathOf(path);
		await mkdir(dirname(target), { recursive: true });
		// Beside the target and renamed over it, so a reader never sees half a file.
		const temp = `${target}.${randomUUID()}.tmp`;
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
		async delete(path) {
			try {
				await unlink(pathOf(path));
			} catch (error) {
				if (missing(error)) return;
				throw error;
			}
		},
		async commit(message) {
			await commitFolder(dir, message);
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
	};
}
