/**
 * The directory storage contract, which each directory host implements
 * natively (ADR-0576): a directory over `node:fs` in Bun
 * (`directory-store.ts`), and a desktop page's directory through the shell,
 * one command per method (`tauri-files.ts`, ADR-0581). The native `Folder`
 * (`native/engine.ts`), the CLI's readers, and a directory's history all
 * read and change files through it. The browser's default folder keeps its
 * files in IndexedDB instead (`browser/storage.ts`).
 *
 * `put` is the one change: one file's bytes, or its removal, landing only
 * while the path holds what the caller expects. It lands whole: a reader,
 * and a crash, see the old file or the new one, never part of either, and a
 * new file never appears empty first. Where Sync publishes, `lock` holds the
 * folder's save lock, the one every cooperating writer takes for each
 * change, across several (`LockingStorage`). Reads, a folder's list, and its
 * captures are built on these.
 *
 * Saves are not ordered by when their methods were called: the last to land
 * on a path wins. A change that must not overwrite bytes its caller did not
 * review carries `ifMatch`.
 *
 * What every host shares is here once (`hostStorage`, `lockingStorage`): the
 * path rule, owning the bytes a put was handed, telling other pages what
 * landed, the order of a listing, holding the lock, and where and under what
 * names a new file is staged, which the desktop shell's own staging matches
 * (`storage.rs` in `tauri-plugin-epicenter-folder`). A host supplies only
 * its own operations (`HostFiles`).
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import { FileError } from './errors.js';
import { pathProblem, readablePath, writableExistingPath } from './paths.js';

export type FileRead = {
	readonly bytes: Uint8Array;
	readonly sha256: string;
};

export type FileListing = {
	/**
	 * Every entry that is not a directory, including files outside portable
	 * scope, symbolic links, and special entries, none of them followed. A
	 * read refuses what is not a regular file.
	 */
	readonly files: readonly { readonly path: string; readonly size: number }[];
	/** Every directory, including empty ones kept for the shell. */
	readonly directories: readonly string[];
};

/** A folder's files, as each host stores them. */
export type FolderStorage = {
	/** Every entry below the folder, `.git` aside. */
	list(): Promise<Result<FileListing, FileError>>;
	/**
	 * Immediate children of a directory by name: real subdirectories in
	 * `directories`, every other entry in `files`, including a symbolic link or
	 * special entry that a read refuses. Nothing present is left out.
	 */
	children(
		directory: string,
	): Promise<Result<{ files: string[]; directories: string[] }, FileError>>;
	read(path: string): Promise<Result<FileRead, FileError>>;
	/**
	 * Publish `bytes` at `path`, or remove its file for `null`, only while
	 * the path holds `ifMatch`: the SHA-256 of the file there, or `null` for
	 * no file. `'stale'` when it does not, and nothing changed. Missing
	 * parent directories are made for a new file. The bytes land whole. The
	 * host checks the condition where the change lands, under the folder's
	 * save lock, the lock the desktop shell and Bun share (ADR-0562). A reply
	 * that was lost is `Unconfirmed`.
	 */
	put(
		path: string,
		bytes: Uint8Array | null,
		ifMatch: string | null,
	): Promise<Result<'landed' | 'stale', FileError>>;
	mkdir(path: string): Promise<Result<undefined, FileError>>;
	/** Remove the empty directory at `path`. */
	rmdir(path: string): Promise<Result<undefined, FileError>>;
};

/**
 * Storage that Sync publishes through: the browser's, and a directory's in
 * Bun, where the `epicenter` CLI runs a desktop page's Sync. A desktop page's
 * own storage has no `lock`, since its Sync never runs there.
 */
export type LockingStorage = FolderStorage & {
	/**
	 * Run `work` holding the folder's save lock, with storage whose changes
	 * land under it without asking for it again, so no cooperating save lands
	 * between `work`'s check and its last change.
	 */
	lock<T>(work: (held: FolderStorage) => Promise<T>): Promise<T>;
};

/**
 * A host's own operations on its storage. The storage built over them
 * (`hostStorage`) calls writes only with a path `pathProblem` accepts, and
 * reads with a structurally safe path, including existing nonportable names.
 * `children` also accepts the root (`''`). Calls carry bytes no caller still holds. `change`
 * is `put`'s change; a listing may come in any order.
 */
export type HostFiles = Pick<
	FolderStorage,
	'list' | 'children' | 'read' | 'mkdir' | 'rmdir'
> & {
	change: FolderStorage['put'];
};

/** Whether a put changed its file, or may have: it landed, or its reply was lost. */
export const mayHaveChanged = (
	result: Result<'landed' | 'stale', FileError>,
): boolean => result.data === 'landed' || result.error?.name === 'Unconfirmed';

/** The folder's private Git directory, which no portable path names and no listing shows. */
export const PRIVATE_DIRECTORY = '.git';

/**
 * This process's id in the names it stages under, so two never pick one
 * name. Made at the first stage, not at import: an insecure origin has no
 * `crypto.randomUUID`, and opening there answers `NoFileSystem` rather than
 * failing to load.
 */
let engine: string | undefined;
let staged = 0;

/**
 * A new staged file's name: its creation time and a per-process counter in
 * base 36, around this process's engine id. Only ASCII letters, digits, and
 * `-`, which the desktop shell admits.
 */
export const scratchName = () => {
	engine ??= crypto.randomUUID().replaceAll('-', '');
	return `${Date.now().toString(36)}-${engine}-${(staged++).toString(36)}`;
};

/**
 * How old a staged file must be before a host removes it. A write moves its
 * staged file right after writing it, so one this old was left by a write
 * that stopped (a crash, a quit). Younger ones may belong to another process
 * writing the same folder: a script and a desktop window share no lock.
 */
const STALE_SCRATCH_MS = 60 * 60 * 1000;

const SCRATCH_NAME = /^([0-9a-z]+)-[0-9a-f]{32}-[0-9a-z]+$/;

/**
 * Whether the staged file `name` was made more than `STALE_SCRATCH_MS`
 * before `now`. A name no host made is never stale.
 */
export function isStaleScratch(name: string, now = Date.now()): boolean {
	const time = SCRATCH_NAME.exec(name)?.[1];
	if (time === undefined) return false;
	const created = Number.parseInt(time, 36);
	return Number.isSafeInteger(created) && now - created > STALE_SCRATCH_MS;
}

const refusal = (path: string) => {
	const problem = pathProblem(path);
	return problem === undefined
		? undefined
		: FileError.InvalidPath({ path, reason: problem });
};

const byPath = (a: { path: string }, b: { path: string }) =>
	a.path < b.path ? -1 : 1;

/**
 * The storage over a host's `files`. `relay`, where the host tells other
 * pages what changed, hears each path a change reached, or may have, as
 * soon as it does.
 */
export function hostStorage(
	files: HostFiles,
	relay: (paths: readonly string[]) => void = () => {},
): FolderStorage {
	return {
		async list() {
			const { data: listed, error } = await files.list();
			if (error !== null) return Err(error);
			return Ok({
				files: [...listed.files].sort(byPath),
				directories: [...listed.directories].sort(),
			});
		},
		async children(directory) {
			const refused = directory === '' ? undefined : refusal(directory);
			if (refused) return refused;
			const { data: found, error } = await files.children(directory);
			if (error !== null) return Err(error);
			return Ok({
				files: [...found.files].sort(),
				directories: [...found.directories].sort(),
			});
		},
		async read(path) {
			return readablePath(path)
				? files.read(path)
				: FileError.InvalidPath({ path, reason: 'the path cannot be read safely' });
		},
		async put(path, bytes, ifMatch) {
			const refused =
				ifMatch !== null && writableExistingPath(path) ? undefined : refusal(path);
			if (refused) return refused;
			const owned = bytes === null ? null : new Uint8Array(bytes);
			let result: Result<'landed' | 'stale', FileError>;
			try {
				result = await files.change(path, owned, ifMatch);
			} catch (cause) {
				result = FileError.Io({ path, operation: 'write', cause });
			}
			if (mayHaveChanged(result)) relay([path]);
			return result;
		},
		async mkdir(path) {
			const refused = refusal(path);
			if (refused) return refused;
			const made = await files.mkdir(path);
			if (made.error === null) relay([path]);
			return made;
		},
		async rmdir(path) {
			const refused = refusal(path);
			if (refused) return refused;
			const removed = await files.rmdir(path);
			if (removed.error === null) relay([path]);
			return removed;
		},
	};
}

/**
 * The storage over a host's `files`, which each take the folder's save lock
 * for themselves where the host has one in this process, with `lock` taking
 * it once to change files through `held`, the same operations without it.
 */
export function lockingStorage(
	files: HostFiles,
	hold: {
		lock<T>(work: () => Promise<T>): Promise<T>;
		held: HostFiles;
	},
	relay?: (paths: readonly string[]) => void,
): LockingStorage {
	return {
		...hostStorage(files, relay),
		lock: (work) => hold.lock(() => work(hostStorage(hold.held, relay))),
	};
}
