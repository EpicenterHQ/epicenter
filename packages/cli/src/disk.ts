/**
 * An action's folder on this computer's disk (ADR-0841, ADR-0850). It is a
 * convenience, not a sandbox: paths are normalized and `.git` is refused, and
 * otherwise a write is a write. Writes replace a whole file at once, keeping
 * the mode of the file they replace; a new `.local` file is `0600`, readable
 * by its owner alone, and a new directory on a `.local` path is `0700`
 * (ADR-0870). `update` holds the app's lock while it reads, changes, and
 * replaces a file, so concurrent updates of one file, from any process, each
 * land. Listing avoids Git, dependencies, and directory links so those trees
 * never become app data.
 */

import { randomUUID } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	type Dirent,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { lstat, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';
import {
	type Folder,
	isLocalPath,
	normalizePath,
	WriteError,
} from '@epicenter/app';

/** How many times `update` tries a file that a writer taking no lock keeps changing before it gives up. */
const UPDATE_TRIES = 10;

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

const LOCK_EX = 2;

/** The C library's `flock`, opened on first use, so only an `update` needs it. */
let flock: ((fd: number, operation: number) => number) | undefined;
function flockOf() {
	if (flock) return flock;
	const libc =
		process.platform === 'darwin'
			? 'libc.dylib'
			: process.platform === 'linux'
				? 'libc.so.6'
				: undefined;
	if (!libc)
		throw new Error(`folder.update needs flock, which ${process.platform} does not have`);
	const { symbols } = dlopen(libc, {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	flock = (fd, operation) => symbols.flock(fd, operation);
	return flock;
}

/**
 * Run `work` holding the lock on directory `dir`, waiting while another
 * process holds it. The lock is the kernel's: it is released when its
 * descriptor closes, here or when the process holding it dies, so a crash
 * never leaves it held. `work` never yields, so nothing else in this process
 * runs while it holds, and the wait blocks only this process, which runs one
 * action (`child.ts`).
 */
function locked<T>(dir: string, work: () => T): T {
	const fd = openSync(dir, 'r');
	try {
		if (flockOf()(fd, LOCK_EX) !== 0) throw new Error(`Could not lock ${dir}`);
		return work();
	} finally {
		closeSync(fd);
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
	const decode = (bytes: Uint8Array | undefined) =>
		bytes === undefined ? undefined : new TextDecoder().decode(bytes);
	/**
	 * Make the directories `path` needs. One on a `.local` path is `0700`,
	 * open to its owner alone, as a `.local` file is `0600`; one that is
	 * already there keeps its mode.
	 */
	function makeParents(path: string) {
		const parts = normalizePath(path).split('/').slice(0, -1);
		const local = parts.findIndex((part) => isLocalPath(part));
		if (local < 0) return void mkdirSync(join(dir, ...parts), { recursive: true });
		mkdirSync(join(dir, ...parts.slice(0, local)), { recursive: true });
		mkdirSync(join(dir, ...parts), { recursive: true, mode: 0o700 });
	}
	/**
	 * Write `bytes` beside the file at `path`, where it can be renamed over
	 * it, so a reader never sees half a file; a file it replaces keeps its
	 * mode, and a new `.local` file is `0600` from before it has a name there.
	 * The file beside it is named `*.local`, so a snapshot taken meanwhile
	 * never commits it.
	 */
	function stage(path: string, bytes: Uint8Array) {
		const target = pathOf(path);
		makeParents(path);
		const temp = `${target}.${randomUUID()}.tmp.local`;
		let mode = isLocalPath(normalizePath(path)) ? 0o600 : undefined;
		try {
			mode = statSync(target).mode & 0o7777;
		} catch (error) {
			if (!missing(error)) throw error;
		}
		try {
			writeFileSync(temp, bytes, mode === undefined ? {} : { mode });
			if (mode !== undefined) chmodSync(temp, mode);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
		return { target, temp };
	}
	function put(path: string, bytes: Uint8Array) {
		const { target, temp } = stage(path, bytes);
		try {
			renameSync(temp, target);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	}
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
		/**
		 * Holding the app's lock, read the file, change it, and replace it only
		 * if it is still what was read, since a writer that takes no lock
		 * (`folder.write`, an editor) may have changed it meanwhile; then read
		 * and change it again. A change that changes nothing writes nothing.
		 */
		async update(path, change) {
			const target = pathOf(path);
			return locked(dir, () => {
				for (let tries = 1; ; tries++) {
					const before = readNow(target);
					const changed = change(decode(before));
					const bytes = new TextEncoder().encode(changed);
					// Compared as bytes: decoding drops a byte order mark the file still has.
					if (sameBytes(before, bytes)) return changed;
					const { temp } = stage(path, bytes);
					if (sameBytes(readNow(target), before)) {
						renameSync(temp, target);
						return changed;
					}
					rmSync(temp, { force: true });
					if (tries === UPDATE_TRIES)
						throw WriteError.Changed({ path: normalizePath(path), why: 'kept' })
							.error;
				}
			});
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
