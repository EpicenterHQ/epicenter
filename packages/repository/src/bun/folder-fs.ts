/**
 * The folder port (`folder/fs.ts`) over `node:fs`, for the folder engine in
 * Bun. `replace` is capture by rename, POSIX only: `rename(target,
 * scratch)` takes whatever is at the path at that instant, then
 * `link(temp, target)` puts the new bytes in only if the path is still
 * empty (it fails with `EEXIST` when an editor created the file meanwhile,
 * and theirs stays). New bytes are written to a temporary file in the same
 * scratch directory first, flushed, and linked, so a reader never sees them
 * half written; a blob's bytes come from the device store as a
 * copy-on-write clone where the file system makes one (APFS, Btrfs, XFS),
 * else a copy, never a hard link, since an editor writing in place would
 * change the sealed object.
 *
 * `watch` is Bun's `fs.watch(root, { recursive: true })`: a name is a hint;
 * a null name or an error means the scope is unknown (`null`), and the
 * watch is opened again; one that cannot be opened again fails for good.
 * On macOS Bun watches through FSEvents and does not surface its drop
 * flags (MustScanSubDirs, UserDropped, KernelDropped); a dropped batch
 * arrives as one `change` naming the root's own basename (observed,
 * `scripts/folder-watch-facts.ts`, and Bun 1.4.3's `fs_events.rs`), so that
 * name is read as scope unknown too. Linux's inotify overflow arrives as a
 * null name. Drops with no signal at all were observed once on macOS, so
 * the engine's periodic scan is what finds those. The root must be a real
 * path (`/tmp` is `/private/tmp`), or FSEvents' names match no prefix.
 */
import { watch as watchFs } from 'node:fs';
import {
	constants,
	copyFile,
	link,
	lstat,
	mkdir,
	open,
	opendir,
	readdir,
	rename,
	rm,
	unlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Ok } from 'wellcrafted/result';
import {
	type Entry,
	type FolderFs,
	FolderFsError,
	SCRATCH,
} from '../folder/fs.js';

const code = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'code' in cause
		? (cause as { code: unknown }).code
		: undefined;
const toPosix = (path: string) =>
	sep === '/' ? path : path.split(sep).join('/');

function kindOf(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): Entry['kind'] {
	if (stats.isSymbolicLink()) return 'symlink';
	if (stats.isFile()) return 'file';
	if (stats.isDirectory()) return 'directory';
	return 'other';
}

/** The folder at `root` as the engine's port. */
export function createBunFolderFs(root: string): FolderFs {
	const at = (path: string) => join(root, ...path.split('/'));
	const scratchAt = (name: string) => join(root, ...SCRATCH.split('/'), name);
	let temporary = 0;

	const statOf = async (path: string): Promise<Entry | null> => {
		try {
			const stats = await lstat(at(path));
			return {
				path,
				kind: kindOf(stats),
				size: stats.size,
				mtime: stats.mtimeMs,
				ino: stats.ino,
			};
		} catch (cause) {
			if (code(cause) === 'ENOENT' || code(cause) === 'ENOTDIR') return null;
			throw cause;
		}
	};

	/** Write `bytes` to a new temporary file beside the scratch files, flushed: its full path. */
	async function stage(bytes: Blob) {
		await mkdir(join(root, ...SCRATCH.split('/')), { recursive: true });
		const temp = scratchAt(`w-${process.pid}-${++temporary}`);
		const name =
			'name' in bytes &&
			typeof bytes.name === 'string' &&
			bytes.name.startsWith('/')
				? bytes.name
				: null;
		if (name !== null) {
			// A file on disk (the device store's object): cloned where the file system can, else copied.
			await copyFile(name, temp, constants.COPYFILE_FICLONE);
			return temp;
		}
		const file = await open(temp, 'wx');
		try {
			const reader = bytes.stream().getReader();
			let offset = 0;
			for (
				let read = await reader.read();
				!read.done;
				read = await reader.read()
			) {
				await file.write(read.value, 0, read.value.byteLength, offset);
				offset += read.value.byteLength;
			}
			await file.sync();
		} finally {
			await file.close();
		}
		return temp;
	}

	/** Take what is at `path` to scratch `name`: whether anything was there. */
	async function capture(path: string, name: string) {
		await mkdir(join(root, ...SCRATCH.split('/')), { recursive: true });
		try {
			await rename(at(path), scratchAt(name));
			return true;
		} catch (cause) {
			if (code(cause) === 'ENOENT' || code(cause) === 'ENOTDIR') return false;
			throw cause;
		}
	}

	return {
		async *walk(prefix, skip) {
			const pending = [prefix];
			while (pending.length > 0) {
				const directory = pending.pop() as string;
				let handle: Awaited<ReturnType<typeof opendir>>;
				try {
					handle = await opendir(directory === '' ? root : at(directory));
				} catch (cause) {
					if (code(cause) === 'ENOENT' || code(cause) === 'ENOTDIR') continue;
					throw cause;
				}
				for await (const dirent of handle) {
					const path =
						directory === '' ? dirent.name : `${directory}/${dirent.name}`;
					if (dirent.isDirectory()) {
						if (skip(path)) continue;
						pending.push(path);
						yield { path, kind: 'directory', size: 0, mtime: 0, ino: 0 };
						continue;
					}
					const entry = await statOf(path);
					if (entry !== null) yield entry;
				}
			}
		},
		stat: statOf,
		async list(dir) {
			try {
				return (await readdir(dir === '' ? root : at(dir))).sort();
			} catch (cause) {
				if (code(cause) === 'ENOENT' || code(cause) === 'ENOTDIR') return [];
				throw cause;
			}
		},
		async read(path) {
			const entry = await statOf(path);
			return entry?.kind === 'file' ? Bun.file(at(path)) : null;
		},
		async replace(path, bytes, { scratch }) {
			let temp: string | null = null;
			try {
				temp = await stage(bytes);
				// The file the link makes is this one: its inode, size and time are what a stat of the path finds until someone else writes there.
				const made = await lstat(temp);
				await mkdir(dirname(at(path)), { recursive: true });
				const displaced = (await capture(path, scratch)) ? scratch : null;
				try {
					await link(temp, at(path));
				} catch (cause) {
					// An editor created the file between the capture and the link: theirs stays.
					if (code(cause) === 'EEXIST')
						return Ok({ written: false, entry: null, displaced });
					throw cause;
				}
				return Ok({
					written: true,
					entry: {
						path,
						kind: 'file',
						size: made.size,
						mtime: made.mtimeMs,
						ino: made.ino,
					},
					displaced,
				});
			} catch (cause) {
				return FolderFsError.Failed({ path, cause });
			} finally {
				if (temp !== null) await unlink(temp).catch(() => {});
			}
		},
		async remove(path, { scratch }) {
			try {
				return Ok((await capture(path, scratch)) ? scratch : null);
			} catch (cause) {
				return FolderFsError.Failed({ path, cause });
			}
		},
		async readScratch(name) {
			try {
				const stats = await lstat(scratchAt(name));
				return stats.isFile()
					? { bytes: Bun.file(scratchAt(name)), mtime: stats.mtimeMs }
					: null;
			} catch {
				return null;
			}
		},
		async restore(name, path) {
			try {
				await mkdir(dirname(at(path)), { recursive: true });
				await link(scratchAt(name), at(path));
				await unlink(scratchAt(name));
				return true;
			} catch {
				return false;
			}
		},
		async drop(name) {
			await rm(scratchAt(name), { force: true });
		},
		async scratches() {
			let names: string[];
			try {
				names = await readdir(join(root, ...SCRATCH.split('/')));
			} catch {
				return [];
			}
			// A temporary a killed process left was never linked anywhere: it goes.
			for (const name of names)
				if (name.startsWith('w-') && !name.startsWith(`w-${process.pid}-`))
					await rm(scratchAt(name), { force: true });
			return names.filter((name) => !name.startsWith('w-'));
		},
		watch(listener, failed) {
			let stopped = false;
			let watcher: ReturnType<typeof watchFs> | null = null;
			const start = () => {
				try {
					watcher = watchFs(root, { recursive: true }, (_event, filename) => {
						if (filename === null || filename === undefined)
							return listener(null);
						const name =
							typeof filename === 'string'
								? filename
								: new TextDecoder().decode(filename);
						// FSEvents dropped events: Bun reports the watched root by its own name.
						if (name === basename(root)) return listener(null);
						listener([
							toPosix(name.startsWith('/') ? relative(root, name) : name),
						]);
					});
					watcher.on('error', () => {
						watcher?.close();
						if (stopped) return;
						// The scope is unknown: the engine scans, and the watch is opened again.
						listener(null);
						reopen();
					});
				} catch (cause) {
					stopped = true;
					failed(cause);
				}
			};
			const reopen = () => {
				if (!stopped) start();
			};
			start();
			return () => {
				stopped = true;
				watcher?.close();
			};
		},
	};
}
