/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0854). Writes
 * replace a whole file at once; a
 * folder's writes go through the run's write log, which refuses a path someone
 * else changed and records what the action wrote (ADR-0850). Listing avoids
 * Git, dependencies, and directory links so those trees never become app data.
 */

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
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
import { basename, dirname, join } from 'node:path';
import { type Folder, normalizePath } from '@epicenter/app';
import type { WriteLog } from './commit.ts';

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Give an action disk-backed data methods, writing through `log`. */
export function folderOnDisk(dir: string, log?: WriteLog): Folder {
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
		const normalized = normalizePath(path);
		const target = join(dir, normalized);
		await mkdir(dirname(target), { recursive: true });
		const temp = log
			? await log.tempFor(target)
			: join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, bytes);
			// The file keeps its mode, so an executable script stays one on disk as in history.
			const existing = await lstat(target).catch(() => undefined);
			if (existing?.isFile()) await chmod(temp, existing.mode & 0o7777);
			// As late as possible, so an edit saved before this point is refused rather than overwritten.
			await log?.check(normalized);
			await rename(temp, target);
			await log?.wrote(normalized, bytes);
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
			const normalized = normalizePath(path);
			await log?.check(normalized);
			try {
				await unlink(join(dir, normalized));
			} catch (error) {
				if (missing(error)) return;
				throw error;
			}
			await log?.deleted(normalized);
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
