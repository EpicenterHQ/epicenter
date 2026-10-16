/**
 * A browser folder's storage, in the origin private file system (OPFS).
 *
 * Each literal folder path is one stored file under the folder's directory,
 * and each directory, empty ones included, is one stored directory. There is
 * no inventory beside the files: a file's identity is the SHA-256 of the
 * bytes read from it, never its size or modification time. `.git` at the
 * folder root is private Git state. No portable path can name it, and
 * listing never shows it.
 *
 * The folder's directory is made by its first change, never by opening or
 * reading (`OpfsFolder`).
 *
 * Every change holds the folder's files Web Lock, so cooperating tabs check
 * a condition and change a file under it without interleaving; `lock` holds
 * it across several changes. Reads take no lock. A change lands whole:
 *
 * - A file's new bytes replace its old ones when its writable stream closes,
 *   so a reader sees the old bytes or the new ones.
 * - A new file is written to `.git/epicenter/scratch` and moved into place,
 *   since OPFS makes a file empty the moment it is first asked for; a crash
 *   then leaves nothing at the path, never an empty file. The move happens
 *   only where the lock has just found no file. A browser that cannot move
 *   a file writes it in place, empty until its stream closes, and takes it
 *   away again when the stream fails.
 * - A stream that fails to close may or may not have published: the outcome
 *   is `Unconfirmed`. The bytes found there afterward are not taken as proof
 *   of which write put them there.
 *
 * A replacement opens its file's stream, then checks once more that the
 * file is there. Chromium opens a stream for a file removed since its handle
 * was taken, and closing that stream creates the file again; the check,
 * whose `getFile` is `NotFoundError` there, aborts it instead. In Chromium an
 * open stream holds a lock that refuses the removal of the file, so a file
 * found by that check is still there when the stream closes. Both behaviors
 * are read from Chromium's source and were observed by probes in Chrome 142;
 * `opfs.test-support.ts` models them, and no other engine is verified.
 *
 * Saves are serialized by the Web Lock in the order they take it, not the
 * order their methods were called: whichever lands last on a path stays.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileListing, FolderStorage } from './boundary.js';
import { hashBytes } from './capture.js';
import { isStaleScratch } from './directory-primitives.js';
import { FileError, UnconfirmedWrite } from './errors.js';
import { ancestors, basename, pathProblem } from './paths.js';

/** A snapshot of a stored file. */
export type OpfsFile = {
	readonly size: number;
	arrayBuffer(): Promise<ArrayBuffer>;
};

export type OpfsWritable = {
	write(data: Uint8Array<ArrayBuffer>): Promise<void>;
	close(): Promise<void>;
	abort(reason?: unknown): Promise<void>;
};

export type OpfsFileHandle = {
	readonly kind: 'file';
	readonly name: string;
	getFile(): Promise<OpfsFile>;
	createWritable(options?: {
		keepExistingData?: boolean;
	}): Promise<OpfsWritable>;
	/** Move this file to `name` in `directory`, at once. */
	move?(directory: OpfsDirectoryHandle, name: string): Promise<void>;
};

export type OpfsDirectoryHandle = {
	readonly kind: 'directory';
	readonly name: string;
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<OpfsDirectoryHandle>;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<OpfsFileHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterable<OpfsFileHandle | OpfsDirectoryHandle>;
};

/** The part of `LockManager` a folder uses. */
export type OpfsLocks = {
	request<T>(
		name: string,
		options: { signal?: AbortSignal },
		work: (lock: unknown) => Promise<T> | T,
	): Promise<T>;
};

/** What a browser folder opens with; tests inject one, browsers use their globals. */
export type OpfsEnvironment = {
	/** The origin's private root, as `navigator.storage.getDirectory` gives it. */
	readonly getDirectory: () => Promise<OpfsDirectoryHandle>;
	/** Web Locks shared by every tab of the origin. Required. */
	readonly locks: OpfsLocks;
	/**
	 * Carries the paths each page of the origin writes to the others, which
	 * is how a page hears changes it did not make (ADR-0548). Omitted: none
	 * are heard.
	 */
	readonly BroadcastChannel?: typeof BroadcastChannel;
	/**
	 * Where the page announces that it resumed from being frozen or from the
	 * back-forward cache, which may have missed any number of writes:
	 * `window` for `pageshow`, `document` for the Page Lifecycle `resume`.
	 * Omitted: a resume is not heard.
	 */
	readonly page?: {
		readonly window?: EventTarget;
		readonly document?: EventTarget;
	};
};

/**
 * A folder's directory, which may not exist yet: what reading finds, and
 * what a change makes.
 */
export type OpfsFolder = {
	/** The directory if it exists, without making it. */
	existing(): Promise<OpfsDirectoryHandle | undefined>;
	/** The directory, made if it is not there. */
	made(): Promise<OpfsDirectoryHandle>;
};

/** A folder whose directory is `handle`, already there. */
export const presentFolder = (handle: OpfsDirectoryHandle): OpfsFolder => ({
	existing: async () => handle,
	made: async () => handle,
});

/** The folder `name` in `origin`, made by the first change that needs it. */
export function folderIn(
	origin: OpfsDirectoryHandle,
	name: string,
): OpfsFolder {
	let made: OpfsDirectoryHandle | undefined;
	let making: Promise<OpfsDirectoryHandle> | undefined;
	return {
		async existing() {
			if (made !== undefined) return made;
			try {
				made = await origin.getDirectoryHandle(name);
				return made;
			} catch (cause) {
				if (errorName(cause) === 'NotFoundError') return undefined;
				throw cause;
			}
		},
		made() {
			if (made !== undefined) return Promise.resolve(made);
			making ??= origin
				.getDirectoryHandle(name, { create: true })
				.then((directory) => {
					made = directory;
					return directory;
				})
				.finally(() => {
					making = undefined;
				});
			return making;
		},
	};
}

/** The folder's private Git directory. `pathProblem` refuses it as a path. */
export const PRIVATE_DIRECTORY = '.git';

/** The name a DOM exception or a thrown error-like object carries. */
export function errorName(cause: unknown): string | undefined {
	if (typeof cause === 'object' && cause !== null && 'name' in cause)
		return String((cause as { name: unknown }).name);
	return undefined;
}

/** Hold `name` for `work`. Every holder waits its turn, in this tab or another. */
export function holding<T>(
	locks: OpfsLocks,
	name: string,
	work: () => Promise<T>,
): Promise<T> {
	return locks.request(name, {}, () => work());
}

export async function readHandle(handle: OpfsFileHandle): Promise<Uint8Array> {
	// A snapshot whose file is replaced before it is read refuses to read.
	// Ask again for the new bytes rather than return a mix or fail the read.
	for (let attempt = 0; ; attempt++) {
		const file = await handle.getFile();
		try {
			return new Uint8Array(await file.arrayBuffer());
		} catch (cause) {
			if (errorName(cause) !== 'NotReadableError' || attempt >= 4) throw cause;
		}
	}
}

/** What a literal path names in a directory tree. */
type Lookup =
	| { readonly kind: 'file'; readonly handle: OpfsFileHandle }
	| { readonly kind: 'directory'; readonly handle: OpfsDirectoryHandle }
	| { readonly kind: 'absent' }
	/** `ancestor` is a file, so nothing can be below it. */
	| { readonly kind: 'underFile'; readonly ancestor: string };

/** What `path` names below `root`; the empty path is `root` itself. */
export async function lookup(
	root: OpfsDirectoryHandle,
	path: string,
): Promise<Lookup> {
	if (path === '') return { kind: 'directory', handle: root };
	const segments = path.split('/');
	let directory = root;
	for (let index = 0; index < segments.length - 1; index++) {
		try {
			directory = await directory.getDirectoryHandle(segments[index]!);
		} catch (cause) {
			const name = errorName(cause);
			if (name === 'NotFoundError') return { kind: 'absent' };
			if (name === 'TypeMismatchError')
				return {
					kind: 'underFile',
					ancestor: segments.slice(0, index + 1).join('/'),
				};
			throw cause;
		}
	}
	const last = segments.at(-1)!;
	try {
		return { kind: 'file', handle: await directory.getFileHandle(last) };
	} catch (cause) {
		const name = errorName(cause);
		if (name === 'NotFoundError') return { kind: 'absent' };
		if (name !== 'TypeMismatchError') throw cause;
	}
	return {
		kind: 'directory',
		handle: await directory.getDirectoryHandle(last),
	};
}

/** The directory at `path`, creating it and its ancestors. */
export async function ensureDirectory(
	root: OpfsDirectoryHandle,
	path: string,
): Promise<Result<OpfsDirectoryHandle, FileError>> {
	if (path === '') return Ok(root);
	let directory = root;
	const segments = path.split('/');
	for (let index = 0; index < segments.length; index++) {
		try {
			directory = await directory.getDirectoryHandle(segments[index]!, {
				create: true,
			});
		} catch (cause) {
			const at = segments.slice(0, index + 1).join('/');
			if (errorName(cause) === 'TypeMismatchError')
				return FileError.NotADirectory({ path: at });
			return FileError.Io({ path: at, operation: 'create directory', cause });
		}
	}
	return Ok(directory);
}

const parentOf = (path: string) => ancestors(path).at(-1) ?? '';

/** The bytes at a private path inside `.git`, or `undefined` when absent. */
export async function readPrivateFile(
	root: OpfsDirectoryHandle,
	path: string,
): Promise<Uint8Array | undefined> {
	const found = await lookup(root, `${PRIVATE_DIRECTORY}/${path}`);
	return found.kind === 'file' ? readHandle(found.handle) : undefined;
}

/**
 * Replace a private file inside `.git` with `bytes`. It publishes when its
 * stream closes. A stream that fails to close throws `UnconfirmedWrite`: the
 * file may hold either version. Any other throw published nothing; a file
 * this call created is removed again, and if its absence cannot be shown the
 * throw is `UnconfirmedWrite` too, since an empty file may be left there.
 */
export async function writePrivateFile(
	root: OpfsDirectoryHandle,
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	const full = `${PRIVATE_DIRECTORY}/${path}`;
	const { data: directory, error: directoryError } = await ensureDirectory(
		root,
		parentOf(full),
	);
	if (directoryError !== null) throw new Error(directoryError.message);
	const name = basename(path);
	const existed = (await lookup(root, full)).kind === 'file';
	const failed = async (cause: unknown) => {
		if (existed) return cause;
		try {
			await directory.removeEntry(name);
		} catch {
			// Whether it went is asked next.
		}
		try {
			await directory.getFileHandle(name);
		} catch (missing) {
			if (errorName(missing) === 'NotFoundError') return cause;
		}
		return new UnconfirmedWrite(full, cause);
	};
	let writable: OpfsWritable;
	try {
		const handle = await directory.getFileHandle(name, { create: true });
		writable = await handle.createWritable({ keepExistingData: false });
	} catch (cause) {
		throw await failed(cause);
	}
	try {
		await writable.write(bytes as Uint8Array<ArrayBuffer>);
	} catch (cause) {
		await writable.abort().catch(() => {});
		throw await failed(cause);
	}
	try {
		await writable.close();
	} catch (cause) {
		throw new UnconfirmedWrite(full, cause);
	}
}

/** Remove a private file inside `.git`; an absent one is already removed. */
export async function removePrivateFile(
	root: OpfsDirectoryHandle,
	path: string,
): Promise<void> {
	const full = `${PRIVATE_DIRECTORY}/${path}`;
	const parent = await lookup(root, parentOf(full));
	if (parent.kind !== 'directory') return;
	try {
		await parent.handle.removeEntry(basename(full));
	} catch (cause) {
		if (errorName(cause) !== 'NotFoundError') throw cause;
	}
}

/** Visit every entry below `directory`, leaving out the root's `.git`. */
export async function walk(
	directory: OpfsDirectoryHandle,
	prefix: string,
	visit: {
		file(path: string, handle: OpfsFileHandle): Promise<void> | void;
		directory?(path: string): void;
	},
): Promise<void> {
	for await (const entry of directory.values()) {
		if (prefix === '' && entry.name === PRIVATE_DIRECTORY) continue;
		const path = prefix + entry.name;
		if (entry.kind === 'directory') {
			visit.directory?.(path);
			await walk(entry, `${path}/`, visit);
		} else await visit.file(path, entry);
	}
}

function invalid(path: string): Result<never, FileError> | undefined {
	const problem = pathProblem(path);
	return problem === undefined
		? undefined
		: FileError.InvalidPath({ path, reason: problem });
}

/** A stream that may have published its bytes or not. */
const unconfirmed = (path: string, cause: unknown) =>
	FileError.Unconfirmed({ path, operation: 'write', cause });

/** Write `bytes` through a new stream on `handle`, which replaces its bytes on close. */
async function writeThrough(
	handle: OpfsFileHandle,
	path: string,
	bytes: Uint8Array,
	{ replacing }: { replacing: boolean },
): Promise<Result<'landed' | 'stale', FileError>> {
	let writable: OpfsWritable;
	try {
		writable = await handle.createWritable({ keepExistingData: false });
	} catch (cause) {
		if (replacing && errorName(cause) === 'NotFoundError') return Ok('stale');
		return FileError.Io({ path, operation: 'write', cause });
	}
	if (replacing) {
		// The stream may belong to a file removed since the handle was taken;
		// closing it would create the file again. While it is open, its lock
		// refuses a removal, so a file found now is there when it closes.
		try {
			await handle.getFile();
		} catch (cause) {
			await writable.abort().catch(() => {});
			if (errorName(cause) === 'NotFoundError') return Ok('stale');
			return FileError.Io({ path, operation: 'write', cause });
		}
	}
	try {
		await writable.write(bytes as Uint8Array<ArrayBuffer>);
	} catch (cause) {
		await writable.abort().catch(() => {});
		return FileError.Io({ path, operation: 'write', cause });
	}
	try {
		await writable.close();
	} catch (cause) {
		return unconfirmed(path, cause);
	}
	return Ok('landed');
}

/**
 * Create `name` in `parent` holding `bytes`, where the lock has just found
 * no file: written whole to `.git/epicenter/scratch`, then moved into place.
 * A browser that cannot move a file writes it in place, and takes away the
 * empty file a failed stream leaves.
 */
async function createAt(
	root: OpfsDirectoryHandle,
	parent: OpfsDirectoryHandle,
	path: string,
	bytes: Uint8Array,
): Promise<Result<'landed' | 'stale', FileError>> {
	const name = basename(path);
	let scratch: OpfsDirectoryHandle;
	let staged: OpfsFileHandle;
	// Named for when it was made, so a later create can tell one a stopped
	// write left behind (`isStaleScratch`).
	const stagedName = `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '')}-0`;
	try {
		scratch = await (
			await (
				await root.getDirectoryHandle(PRIVATE_DIRECTORY, { create: true })
			).getDirectoryHandle('epicenter', { create: true })
		).getDirectoryHandle('scratch', { create: true });
		staged = await scratch.getFileHandle(stagedName, { create: true });
	} catch (cause) {
		return FileError.Io({ path, operation: 'write', cause });
	}
	await sweepScratch(scratch);
	const discard = () => scratch.removeEntry(stagedName).catch(() => {});
	if (staged.move === undefined) {
		await discard();
		return createInPlace(parent, path, bytes);
	}
	const written = await writeThrough(staged, path, bytes, { replacing: false });
	if (written.error !== null) {
		await discard();
		// What a scratch file holds is nobody's: nothing reached the path.
		return FileError.Io({ path, operation: 'write', cause: written.error });
	}
	try {
		await staged.move(parent, name);
	} catch (cause) {
		await discard();
		const found = await lookup(parent, name).catch(() => undefined);
		if (found?.kind === 'absent')
			return FileError.Io({ path, operation: 'write', cause });
		return unconfirmed(path, cause);
	}
	return Ok('landed');
}

/**
 * Remove what writes that stopped (a crash, a closed tab) left staged. A
 * write moves its staged file right after writing it, so only one old
 * enough to be abandoned is taken; another tab may be writing now.
 */
async function sweepScratch(scratch: OpfsDirectoryHandle) {
	try {
		const now = Date.now();
		for await (const entry of scratch.values())
			if (entry.kind === 'file' && isStaleScratch(entry.name, now))
				await scratch.removeEntry(entry.name).catch(() => {});
	} catch {
		// Leftovers are inert; a create that cannot clear them still writes.
	}
}

/** A create where the browser cannot move a file: in place, empty until it closes. */
async function createInPlace(
	parent: OpfsDirectoryHandle,
	path: string,
	bytes: Uint8Array,
): Promise<Result<'landed' | 'stale', FileError>> {
	const name = basename(path);
	let handle: OpfsFileHandle;
	try {
		handle = await parent.getFileHandle(name, { create: true });
	} catch (cause) {
		if (errorName(cause) === 'TypeMismatchError')
			return FileError.NotAFile({ path });
		return FileError.Io({ path, operation: 'write', cause });
	}
	const written = await writeThrough(handle, path, bytes, { replacing: false });
	if (written.error === null || written.error.name === 'Unconfirmed')
		return written;
	try {
		await parent.removeEntry(name);
	} catch {
		// Whether it went is asked next.
	}
	const found = await lookup(parent, name).catch(() => undefined);
	return found?.kind === 'absent' ? written : unconfirmed(path, written.error);
}

/**
 * The storage of the browser folder in `folder`, whose changes hold the
 * Web Lock `filesLock`. `landed` hears each path a change reached, or may
 * have, as soon as it does, for the other pages of the origin.
 */
export function createOpfsStorage({
	folder,
	locks,
	filesLock,
	landed,
}: {
	folder: OpfsFolder;
	locks: OpfsLocks;
	/** The Web Lock every change of this folder holds. */
	filesLock: string;
	landed: (paths: readonly string[]) => void;
}): FolderStorage {
	async function readOne(path: string) {
		try {
			const root = await folder.existing();
			const found =
				root === undefined
					? ({ kind: 'absent' } as const)
					: await lookup(root, path);
			if (found.kind === 'directory') return FileError.NotAFile({ path });
			if (found.kind !== 'file') return FileError.NotFound({ path });
			const bytes = await readHandle(found.handle);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		} catch (cause) {
			if (errorName(cause) === 'NotFoundError')
				return FileError.NotFound({ path });
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	/** One change, with the lock held. */
	async function change(
		path: string,
		bytes: Uint8Array | null,
		ifMatch: string | null,
	): Promise<Result<'landed' | 'stale', FileError>> {
		const root = bytes === null ? await folder.existing() : await folder.made();
		if (root === undefined) return Ok(ifMatch === null ? 'landed' : 'stale');
		let found: Lookup;
		try {
			found = await lookup(root, path);
		} catch (cause) {
			return FileError.Io({ path, operation: 'write', cause });
		}
		if (found.kind === 'directory') return FileError.NotAFile({ path });
		if (found.kind === 'underFile') {
			if (bytes === null) return Ok(ifMatch === null ? 'landed' : 'stale');
			return FileError.NotADirectory({ path: found.ancestor });
		}
		let current: string | null = null;
		if (found.kind === 'file')
			try {
				current = await hashBytes(await readHandle(found.handle));
			} catch (cause) {
				if (errorName(cause) !== 'NotFoundError')
					return FileError.Io({ path, operation: 'write', cause });
				found = { kind: 'absent' };
			}
		if (current !== ifMatch) return Ok('stale');
		if (bytes === null) {
			if (current === null) return Ok('landed');
			const parent = await lookup(root, parentOf(path));
			if (parent.kind !== 'directory') return Ok('stale');
			try {
				await parent.handle.removeEntry(basename(path));
			} catch (cause) {
				if (errorName(cause) === 'NotFoundError') return Ok('stale');
				return FileError.Io({ path, operation: 'remove', cause });
			}
			return Ok('landed');
		}
		if (found.kind === 'file')
			return writeThrough(found.handle, path, bytes, { replacing: true });
		const { data: parent, error: parentError } = await ensureDirectory(
			root,
			parentOf(path),
		);
		if (parentError !== null) return Err(parentError);
		return createAt(root, parent, path, bytes);
	}

	/** The storage, each change under `guard`; `held` when the lock is. */
	const storage = (
		guard: <T>(work: () => Promise<T>) => Promise<T>,
		held: boolean,
	): FolderStorage => ({
		async list() {
			const files: { path: string; size: number }[] = [];
			const directories: string[] = [];
			try {
				const root = await folder.existing();
				if (root !== undefined)
					await walk(root, '', {
						async file(path, handle) {
							try {
								files.push({ path, size: (await handle.getFile()).size });
							} catch (cause) {
								if (errorName(cause) !== 'NotFoundError') throw cause;
							}
						},
						directory: (path) => directories.push(path),
					});
			} catch (cause) {
				return FileError.Io({ path: '', operation: 'list', cause });
			}
			const listing: FileListing = {
				files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
				directories: directories.sort(),
			};
			return Ok(listing);
		},
		async children(directory) {
			if (directory !== '') {
				const refused = invalid(directory);
				if (refused) return refused;
			}
			try {
				const root = await folder.existing();
				if (root === undefined)
					return directory === ''
						? Ok({ files: [], directories: [] })
						: FileError.NotFound({ path: directory });
				const found = await lookup(root, directory);
				if (found.kind === 'file')
					return FileError.NotADirectory({ path: directory });
				if (found.kind !== 'directory')
					return FileError.NotFound({ path: directory });
				const files: string[] = [];
				const directories: string[] = [];
				for await (const entry of found.handle.values()) {
					if (directory === '' && entry.name === PRIVATE_DIRECTORY) continue;
					(entry.kind === 'file' ? files : directories).push(entry.name);
				}
				return Ok({ files: files.sort(), directories: directories.sort() });
			} catch (cause) {
				return FileError.Io({ path: directory, operation: 'list', cause });
			}
		},
		async read(path) {
			const refused = invalid(path);
			if (refused) return refused;
			return readOne(path);
		},
		async put(path, bytes, ifMatch) {
			const refused = invalid(path);
			if (refused) return refused;
			const owned = bytes === null ? null : new Uint8Array(bytes);
			const result = await guard(() => change(path, owned, ifMatch));
			if (result.data === 'landed' || result.error?.name === 'Unconfirmed')
				landed([path]);
			return result;
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const made = await guard(async () =>
				ensureDirectory(await folder.made(), path),
			);
			if (made.error !== null) return Err(made.error);
			landed([path]);
			return Ok(undefined);
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			const removed = await guard(
				async (): Promise<Result<undefined, FileError>> => {
					try {
						const root = await folder.existing();
						if (root === undefined) return FileError.NotFound({ path });
						const found = await lookup(root, path);
						if (found.kind === 'file') return FileError.NotADirectory({ path });
						if (found.kind !== 'directory') return FileError.NotFound({ path });
						for await (const _ of found.handle.values())
							return FileError.DirectoryNotEmpty({ path });
						const parent = await lookup(root, parentOf(path));
						if (parent.kind !== 'directory')
							return FileError.NotFound({ path });
						await parent.handle.removeEntry(basename(path));
						return Ok(undefined);
					} catch (cause) {
						const name = errorName(cause);
						if (name === 'InvalidModificationError')
							return FileError.DirectoryNotEmpty({ path });
						if (name === 'NotFoundError') return FileError.NotFound({ path });
						return FileError.Io({
							path,
							operation: 'remove directory',
							cause,
						});
					}
				},
			);
			if (removed.error === null) landed([path]);
			return removed;
		},
		lock: (work) =>
			held
				? work(storage(guard, true))
				: holding(locks, filesLock, () =>
						work(storage((step) => step(), true)),
					),
	});
	return storage((work) => holding(locks, filesLock, work), false);
}
