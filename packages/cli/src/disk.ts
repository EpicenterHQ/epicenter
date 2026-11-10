/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0850). It is a
 * convenience, not a sandbox: paths are normalized and `.git` is refused, and
 * otherwise a write is a write. Writes replace a whole file at once, keeping
 * the mode of the file they replace; `update` replaces it only when it is
 * still what its change read, so concurrent updates of one file, from any
 * process, each land. Listing avoids Git, dependencies, and directory links
 * so those trees never become app data.
 */

import { createHash, randomUUID } from 'node:crypto';
import { type Dirent, readFileSync, renameSync } from 'node:fs';
import {
	chmod,
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

/** How many times `update` reads and changes a file that keeps changing before it gives up. */
const UPDATE_TRIES = 10;

/** How old another update's file beside the target is before it is taken for one a crash left. */
const ABANDONED_MS = 30_000;

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A short name for `text`, or for no file, that two updates of the same text share. */
function textTag(text: string | undefined) {
	return text === undefined
		? 'none'
		: createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The text at `target` now, read without yielding. */
function readNow(target: string) {
	try {
		return readFileSync(target, 'utf8');
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
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
	/**
	 * Write `bytes` beside the file at `path` and rename it over, so a reader
	 * never sees half a file; a file it replaces keeps its mode. The file
	 * beside it is named `*.local`, so a snapshot taken meanwhile never
	 * commits it.
	 *
	 * Given `replacing`, the text the bytes were made from, it writes only
	 * over that text, and answers whether it did. Its file beside is named
	 * for that text and made only when no other is there, so two updates of
	 * the same text never both write; and just before the rename it reads the
	 * file again and leaves it as it is when the text has changed.
	 */
	async function replace(
		path: string,
		bytes: Uint8Array,
		replacing?: { text: string | undefined },
	) {
		const target = pathOf(path);
		await mkdir(dirname(target), { recursive: true });
		const temp = `${target}.${replacing ? textTag(replacing.text) : randomUUID()}.tmp.local`;
		let mode: number | undefined;
		try {
			mode = (await stat(target)).mode & 0o7777;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		try {
			await writeFile(temp, bytes, {
				flag: replacing ? 'wx' : 'w',
				...(mode === undefined ? {} : { mode }),
			});
		} catch (error) {
			if (!replacing || (error as NodeJS.ErrnoException).code !== 'EEXIST')
				throw error;
			// Another update of the same text is writing; one a crash left behind is cleared.
			const left = await stat(temp).catch(() => undefined);
			if (left && Date.now() - left.mtimeMs > ABANDONED_MS)
				await rm(temp, { force: true });
			return false;
		}
		let renamed = false;
		try {
			if (mode !== undefined) await chmod(temp, mode);
			if (!replacing) await rename(temp, target);
			// Read and rename without yielding, so nothing in this process runs between them.
			else if (readNow(target) === replacing.text) renameSync(temp, target);
			else return false;
			renamed = true;
			return true;
		} finally {
			// Once renamed, the name may already be another update's.
			if (!renamed) await rm(temp, { force: true });
		}
	}
	async function read(path: string) {
		const bytes = await readBytes(path);
		return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
	}
	return {
		path: dir,
		readBytes,
		read,
		async writeBytes(path, bytes) {
			await replace(path, bytes);
		},
		async write(path, text) {
			await replace(path, new TextEncoder().encode(text));
		},
		async update(path, change) {
			for (let tries = 1; ; tries++) {
				const text = await read(path);
				const changed = change(text);
				const bytes = new TextEncoder().encode(changed);
				if (await replace(path, bytes, { text })) return changed;
				if (tries === UPDATE_TRIES)
					throw Object.freeze({
						name: 'Changed',
						message: `${normalizePath(path)} kept changing while it was updated`,
					});
				// A random wait, doubling with each try, so updates that met spread apart.
				await Bun.sleep(Math.random() * 2 ** tries);
			}
		},
		async delete(path) {
			try {
				await unlink(pathOf(path));
			} catch (error) {
				if (missing(error)) return;
				throw error;
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
	};
}
