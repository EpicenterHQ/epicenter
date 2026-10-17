/**
 * A directory folder's storage, over its host's file system calls
 * (`directory-primitives.ts`): `node:fs` in Bun, and the folder plugin's
 * commands on the desktop.
 *
 * Every change lands whole and checked where it lands. A file's bytes are
 * written to a scratch file under `.git/epicenter/scratch` and renamed over
 * the path, carrying what the change expects there (`Expectation`), which
 * the host checks under the directory's save lock: another program sees the
 * old file or the new one, never part of either, and never an empty file
 * first. A removal carries its expectation too. A host that refuses one
 * changed nothing, and the change is `stale`; any other failure of a rename
 * or a removal may have landed, and is `Unconfirmed`.
 *
 * Paths are literal. A symbolic link is never followed: a path through one
 * is unusable. On a case-insensitive disk `plan.md` can reach `Plan.md`;
 * a path whose stored name differs reads as absent, and a write refuses to
 * land on the other file.
 *
 * `.git` at the root is private Git state, which only `git` changes; the
 * scratch files are this storage's own.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FileRead,
	type FolderStorage,
	type HostFiles,
	hostStorage,
	type LockingStorage,
	lockingStorage,
	PRIVATE_DIRECTORY,
	SCRATCH_DIRECTORY,
	scratchName,
} from './boundary.js';
import type {
	DirectoryPrimitives,
	EntryKind,
	Expectation,
} from './directory-primitives.js';
import { FileError, UnexpectedTarget } from './errors.js';
import { hashBytes } from './hash.js';

/** What a literal folder path names on disk. */
type Found =
	| { readonly kind: 'file' | 'other'; readonly size: number }
	| { readonly kind: 'directory' }
	| { readonly kind: 'absent' }
	/** A case-variant of one of its names is stored there instead. */
	| { readonly kind: 'occupied' }
	/** The path passes through a symbolic link, which is never followed. */
	| { readonly kind: 'link' }
	/** `ancestor` is not a directory, so nothing can be below it. */
	| { readonly kind: 'underFile'; readonly ancestor: string };

const linkRefusal = (path: string) =>
	FileError.InvalidPath({
		path,
		reason: 'the path passes through a symbolic link',
	});

/** The directory's save lock, and its primitives without it. */
type Hold = {
	lock<T>(work: () => Promise<T>): Promise<T>;
	held: DirectoryPrimitives;
};

/**
 * The storage of the directory at absolute path `root`.
 *
 * Each change goes through `primitives`, whose renames and removals each
 * take the directory's save lock where the host has one in this process (a
 * desktop page's shell takes it for each change itself). With `hold`, where
 * Sync publishes (Bun), `lock` takes that lock and changes files through
 * `held`, the same calls without it.
 */
export function createDirectoryStorage(options: {
	root: string;
	primitives: DirectoryPrimitives;
}): FolderStorage;
export function createDirectoryStorage(options: {
	root: string;
	primitives: DirectoryPrimitives;
	hold: Hold;
}): LockingStorage;
export function createDirectoryStorage({
	root,
	primitives,
	hold,
}: {
	root: string;
	primitives: DirectoryPrimitives;
	hold?: Hold;
}): FolderStorage | LockingStorage {
	const absolute = (path: string) => (path === '' ? root : `${root}/${path}`);

	const host = (files: DirectoryPrimitives): HostFiles => {
		/** Whether `name` is stored in `parent` under exactly that name. */
		async function literal(
			parent: string,
			name: string,
			found: { readonly kind: EntryKind; readonly name?: string },
		) {
			if (found.kind === 'link' || found.kind === 'other') return true;
			if (found.name !== undefined) return found.name === name;
			return (await files.readDir(parent)).some((entry) => entry.name === name);
		}

		async function find(path: string): Promise<Found> {
			if (path === '') return { kind: 'directory' };
			const segments = path.split('/');
			let at = root;
			for (let index = 0; index < segments.length; index++) {
				const name = segments[index]!;
				const next = `${at}/${name}`;
				const found = await files.lstat(next);
				if (found === undefined) return { kind: 'absent' };
				if (found.kind === 'link') return { kind: 'link' };
				// A name stored under another spelling, on a case-insensitive
				// disk, is another entry: nothing reads through it, and nothing
				// is written into it.
				if (!(await literal(at, name, found))) return { kind: 'occupied' };
				if (index === segments.length - 1)
					return found.kind === 'directory'
						? { kind: 'directory' }
						: { kind: found.kind, size: found.size };
				if (found.kind !== 'directory')
					return {
						kind: 'underFile',
						ancestor: segments.slice(0, index + 1).join('/'),
					};
				at = next;
			}
			return { kind: 'absent' };
		}

		async function readOne(path: string): Promise<Result<FileRead, FileError>> {
			try {
				const found = await find(path);
				if (found.kind === 'link') return linkRefusal(path);
				if (found.kind === 'directory') return FileError.NotAFile({ path });
				if (found.kind === 'other')
					return FileError.InvalidPath({
						path,
						reason: 'it is not a regular file and is not followed',
					});
				if (found.kind !== 'file') return FileError.NotFound({ path });
				const bytes = await files.readFile(absolute(path));
				return Ok({ bytes, sha256: await hashBytes(bytes) });
			} catch (cause) {
				if (
					(await files.lstat(absolute(path)).catch(() => undefined)) ===
					undefined
				)
					return FileError.NotFound({ path });
				return FileError.Io({ path, operation: 'read', cause });
			}
		}

		/** Where a change to `path` may land, or why it cannot. */
		async function landing(path: string): Promise<Result<Found, FileError>> {
			const found = await find(path);
			if (found.kind === 'link') return linkRefusal(path);
			if (found.kind === 'directory') return FileError.NotAFile({ path });
			if (found.kind === 'occupied' || found.kind === 'other')
				return FileError.InvalidPath({
					path,
					reason: 'another entry occupies this name',
				});
			return Ok(found);
		}

		async function change(
			path: string,
			bytes: Uint8Array | null,
			ifMatch: string | null,
		): Promise<Result<'landed' | 'stale', FileError>> {
			const { data: found, error } = await landing(path);
			if (error !== null) return Err(error);
			const expected: Expectation =
				ifMatch === null ? 'absent' : { sha256: ifMatch };
			if (bytes === null) {
				if (found.kind !== 'file')
					return Ok(ifMatch === null ? 'landed' : 'stale');
				if (ifMatch === null) return Ok('stale');
				try {
					await files.remove(absolute(path), { expected });
				} catch (cause) {
					if (cause instanceof UnexpectedTarget) return Ok('stale');
					return FileError.Unconfirmed({ path, operation: 'remove', cause });
				}
				return Ok('landed');
			}
			if (found.kind === 'underFile')
				return FileError.NotADirectory({ path: found.ancestor });
			const parent = path.split('/').slice(0, -1).join('/');
			const scratch = `${root}/${SCRATCH_DIRECTORY}/${scratchName()}`;
			try {
				if (found.kind === 'absent' && parent !== '')
					await files.mkdir(absolute(parent));
				await files.mkdir(`${root}/${SCRATCH_DIRECTORY}`);
				await files.writeFile(scratch, bytes, { createNew: true });
			} catch (cause) {
				await files.remove(scratch).catch(() => {});
				return FileError.Io({ path, operation: 'write', cause });
			}
			try {
				await files.rename(scratch, absolute(path), expected);
			} catch (cause) {
				await files.remove(scratch).catch(() => {});
				if (cause instanceof UnexpectedTarget) return Ok('stale');
				return FileError.Unconfirmed({ path, operation: 'write', cause });
			}
			return Ok('landed');
		}

		return {
			async list() {
				const entries: { path: string; size: number }[] = [];
				const directories: string[] = [];
				async function visit(directory: string, prefix: string) {
					for (const entry of await files.readDir(directory)) {
						if (prefix === '' && entry.name === PRIVATE_DIRECTORY) continue;
						const path = prefix + entry.name;
						const at = `${directory}/${entry.name}`;
						if (entry.kind === 'directory') {
							directories.push(path);
							await visit(at, `${path}/`);
							continue;
						}
						const found = await files.lstat(at);
						if (found !== undefined) entries.push({ path, size: found.size });
					}
				}
				try {
					await visit(root, '');
				} catch (cause) {
					return FileError.Io({ path: '', operation: 'list', cause });
				}
				return Ok({ files: entries, directories });
			},
			async children(directory) {
				try {
					const found = await find(directory);
					if (found.kind === 'link') return linkRefusal(directory);
					if (found.kind === 'file' || found.kind === 'other')
						return FileError.NotADirectory({ path: directory });
					if (found.kind !== 'directory')
						return FileError.NotFound({ path: directory });
					const listed: string[] = [];
					const nested: string[] = [];
					for (const entry of await files.readDir(absolute(directory))) {
						if (directory === '' && entry.name === PRIVATE_DIRECTORY) continue;
						(entry.kind === 'directory' ? nested : listed).push(entry.name);
					}
					return Ok({ files: listed, directories: nested });
				} catch (cause) {
					return FileError.Io({ path: directory, operation: 'list', cause });
				}
			},
			read: readOne,
			change,
			async mkdir(path) {
				try {
					const found = await find(path);
					if (found.kind === 'link') return linkRefusal(path);
					if (found.kind === 'underFile')
						return FileError.NotADirectory({ path: found.ancestor });
					if (found.kind === 'file' || found.kind === 'other')
						return FileError.NotADirectory({ path });
					if (found.kind === 'occupied')
						return FileError.InvalidPath({
							path,
							reason: 'another entry occupies this name',
						});
					if (found.kind === 'absent') await files.mkdir(absolute(path));
				} catch (cause) {
					return FileError.Io({ path, operation: 'create directory', cause });
				}
				return Ok(undefined);
			},
			async rmdir(path) {
				try {
					const found = await find(path);
					if (found.kind === 'link') return linkRefusal(path);
					if (found.kind === 'file' || found.kind === 'other')
						return FileError.NotADirectory({ path });
					if (found.kind !== 'directory') return FileError.NotFound({ path });
					if ((await files.readDir(absolute(path))).length > 0)
						return FileError.DirectoryNotEmpty({ path });
					await files.remove(absolute(path));
				} catch (cause) {
					if (
						(await files.lstat(absolute(path)).catch(() => undefined)) ===
						undefined
					)
						return FileError.NotFound({ path });
					return FileError.Io({ path, operation: 'remove directory', cause });
				}
				return Ok(undefined);
			},
		};
	};
	if (hold === undefined) return hostStorage(host(primitives));
	return lockingStorage(host(primitives), {
		lock: hold.lock,
		held: host(hold.held),
	});
}
