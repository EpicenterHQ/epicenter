/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0850). It is a
 * convenience, not a sandbox: paths are normalized and `.git` is refused, and
 * otherwise a write is a write. Writes replace a whole file at once, keeping
 * the mode of the file they replace; a new file under `local/` is `0600`,
 * readable by its owner alone, and a new directory there is `0700`. `update`
 * reads, changes, and replaces a file without yielding, so two updates never interleave: one process runs actions (ADR-0936), and
 * nothing here waits or looks twice. A writer outside epicenter, such as an
 * editor, is not guarded against.
 * Listing avoids Git, dependencies, and directory links so those trees never
 * become app data.
 */

import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	type Dirent,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { lstat, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	type Folder,
	isUnderLocal,
	normalizePath,
	Ok,
	textUpdate,
} from '@epicenter/app';

function missing(error: unknown) {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The bytes at `target` now, or `undefined` when there is no file. */
function readNow(target: string) {
	try {
		return readFileSync(target);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

/** Whether two reads found the same file: the same bytes, or no file both times. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined) {
	return a === undefined || b === undefined
		? a === b
		: Buffer.from(a).equals(b);
}

/** Where a write keeps its bytes until they take the target's name. */
const TEMP = 'local/.tmp';

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
	const decode = (bytes: Uint8Array | undefined) =>
		bytes === undefined ? undefined : new TextDecoder().decode(bytes);
	/**
	 * Replace the file at `path` with `bytes` at once, so a reader never sees
	 * half a file. The bytes are written to a file in `local/.tmp/` and renamed
	 * over the target: `local/` is never committed, so a checkpoint taken
	 * meanwhile finds nothing new under `data/`. A file that is replaced keeps
	 * its mode. A new file under `local/` is `0600` from before it has its
	 * name, and a new directory there is `0700`; one already there keeps its
	 * mode.
	 */
	function put(path: string, bytes: Uint8Array) {
		const normal = normalizePath(path);
		const target = join(dir, normal);
		const owner = { recursive: true, mode: 0o700 } as const;
		mkdirSync(
			dirname(target),
			isUnderLocal(normal) ? owner : { recursive: true },
		);
		mkdirSync(join(dir, TEMP), owner);
		const temp = join(dir, TEMP, randomUUID());
		let kept: number | undefined;
		try {
			kept = statSync(target).mode & 0o7777;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		try {
			writeFileSync(temp, bytes, {
				mode: kept ?? (isUnderLocal(normal) ? 0o600 : 0o666),
			});
			// The umask narrows a new file's mode; a kept mode is exact.
			if (kept !== undefined) chmodSync(temp, kept);
			renameSync(temp, target);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	}
	// Read, decide, and replace with no await between them: that is what keeps
	// two updates in this process from interleaving.
	const edit: Folder['edit'] = async (path, decide) => {
		const before = readNow(pathOf(path));
		const result = decide(decode(before));
		if (result.data === null) return result;
		const { text, value } = result.data;
		if (text === undefined) return Ok(value);
		const bytes = new TextEncoder().encode(text);
		// Decoding drops a byte order mark, so compare the original bytes.
		if (!sameBytes(before, bytes)) put(path, bytes);
		return Ok(value);
	};
	return {
		path: dir,
		readBytes,
		read: async (path) => decode(await readBytes(path)),
		async writeBytes(path, bytes) {
			put(path, bytes);
		},
		async write(path, text) {
			put(path, new TextEncoder().encode(text));
		},
		edit,
		update: textUpdate(edit),
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
