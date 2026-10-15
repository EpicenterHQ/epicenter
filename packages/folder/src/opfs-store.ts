/**
 * Origin private file system (OPFS) storage for one browser folder.
 *
 * Each literal folder path is one stored file under the folder's directory,
 * and each directory, empty ones included, is one stored directory. There is
 * no inventory beside the files: a file's identity is the SHA-256 of the
 * bytes read from it, never its size or modification time. `.git` at the
 * folder root is private Git state. No portable path can name it, and
 * listing, capture, and the file methods never show it.
 *
 * Every mutation holds the folder's files Web Lock, so cooperating tabs and
 * handles check a condition and publish under it without interleaving. Reads
 * take no lock. A file's new bytes publish when its writable stream closes,
 * so a reader sees the old bytes or the new ones. A new file is visible,
 * empty, from the moment it is created until its stream closes.
 *
 * A replacement creates nothing, not even a directory on the way: it opens
 * the file without `create`, opens its stream, then checks once more that
 * the file is there. Chromium opens a stream for a file removed since its
 * handle was taken, and closing that stream creates the file again; the
 * check, whose `getFile` is `NotFoundError` there, aborts it instead and the
 * path stays absent (`NotFound`, or `Conflict` when a sha256 was expected).
 * In Chromium an open stream holds a lock that refuses the removal of the
 * file and the recursive removal of any directory above it, so a file found
 * by that check is still there when the stream closes. Both behaviors are
 * read from Chromium's source and were observed by probes in Chrome 142;
 * `opfs.test-support.ts` models them, and no other engine is verified. A removal
 * by code that skips the files lock is the case it covers, since every
 * mutation here holds that lock.
 *
 * An application checks every condition first, then applies its steps in
 * order and hints each step that landed. A failure after the first step is
 * `Partial`; nothing is rolled back. Parent directories a step created stay
 * even when the step fails. A stream that fails to close may or may not have
 * published: the outcome is `Unconfirmed`, and the path is hinted. The bytes
 * found there afterward are not taken as proof of which write put them there.
 * A new file whose stream never reached its close is removed again; when its
 * absence cannot be established, the outcome is `Unconfirmed` too.
 *
 * Saves are serialized by the Web Lock in the order they take it, not the
 * order their methods were called: whichever lands last on a path stays.
 *
 * Each write and removal also names what it expects at its path when it
 * lands (`Expectation`), on the stream it opens or the removal it asks for.
 * OPFS ignores it: the files lock already holds every change of an origin.
 * A directory handle (`directory-handle.ts`) passes it to its host, which
 * checks it where the bytes publish, so writers that share no lock still
 * cannot overtake each other's saves unseen.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	CapturedFiles,
	FileBoundary,
	FileChange,
	FileListing,
	FileRead,
} from './boundary.js';
import { hashBytes } from './capture.js';
import {
	ApplyError,
	FileError,
	type FileStep,
	UnconfirmedWrite,
	UnexpectedTarget,
} from './errors.js';
import { ancestors, basename, isPortablePath, pathProblem } from './paths.js';

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

/**
 * What a change expects at its path when it lands: nothing there, a file, a
 * file whose bytes hash to `sha256`, or whatever is there.
 */
export type Expectation =
	| 'absent'
	| 'present'
	| { readonly sha256: string }
	| 'any';

export type OpfsFileHandle = {
	readonly kind: 'file';
	readonly name: string;
	getFile(): Promise<OpfsFile>;
	createWritable(options?: {
		keepExistingData?: boolean;
		/** Checked by a directory handle's host when the stream closes; OPFS ignores it. */
		expected?: Expectation;
	}): Promise<OpfsWritable>;
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
	removeEntry(
		name: string,
		options?: {
			recursive?: boolean;
			/** Checked by a directory handle's host; OPFS ignores it. */
			expected?: Expectation;
		},
	): Promise<void>;
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
	/** Carries file-change hints between tabs. Omitted: none are heard. */
	readonly BroadcastChannel?: typeof BroadcastChannel;
};

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
export type Lookup =
	| { readonly kind: 'file'; readonly handle: OpfsFileHandle }
	| { readonly kind: 'directory'; readonly handle: OpfsDirectoryHandle }
	| { readonly kind: 'absent' }
	/** Nothing is stored under this exact name, but a case-variant is. */
	| { readonly kind: 'occupied' }
	/** A symbolic link, which is never followed. */
	| { readonly kind: 'link' }
	/** `ancestor` is a file, so nothing can be below it. */
	| { readonly kind: 'underFile'; readonly ancestor: string };

/** Whether `cause` is a directory handle's refusal of a symbolic link. */
const isLink = (cause: unknown) =>
	typeof cause === 'object' &&
	cause !== null &&
	(cause as { link?: unknown }).link === true;

const absentOrOccupied = (cause: unknown): Lookup =>
	isLink(cause)
		? { kind: 'link' }
		: (cause as { occupied?: unknown }).occupied === true
			? { kind: 'occupied' }
			: { kind: 'absent' };

/** What a symbolic link at `path` is reported as. */
const linkRefusal = (path: string) =>
	FileError.InvalidPath({
		path,
		reason: 'the path passes through a symbolic link',
	});

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
			if (name === 'NotFoundError') return absentOrOccupied(cause);
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
		if (name === 'NotFoundError') return absentOrOccupied(cause);
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
			if (isLink(cause)) return linkRefusal(at);
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
	const { error: removeError } = await removeFileAt(
		root,
		`${PRIVATE_DIRECTORY}/${path}`,
	);
	if (removeError !== null && removeError.name !== 'NotFound')
		throw new Error(removeError.message);
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

const byPath = <T>([a]: [string, T], [b]: [string, T]) =>
	a < b ? -1 : a > b ? 1 : 0;

/**
 * Every portable file's bytes, read now. A file removed while it is read is
 * left out, as if enumeration had missed it; any other failure is reported.
 */
export async function captureFiles(
	root: OpfsDirectoryHandle,
): Promise<CapturedFiles> {
	const files = new Map<string, Uint8Array>();
	const unreadable: { path: string; error: FileError }[] = [];
	await walk(root, '', {
		async file(path, handle) {
			if (!isPortablePath(path)) return;
			try {
				files.set(path, await readHandle(handle));
			} catch (cause) {
				if (errorName(cause) === 'NotFoundError') return;
				unreadable.push({
					path,
					error: FileError.Io({ path, operation: 'read', cause }).error,
				});
			}
		},
	});
	return { files: new Map([...files].sort(byPath)), unreadable };
}

/** What a write requires of its path when its bytes land. */
export type WriteTarget =
	/** A file must be there; with `expectedSha256` the absence is a conflict. */
	| { readonly kind: 'replace'; readonly expectedSha256?: string }
	/** Nothing may be there: a new file, or a move's destination. */
	| { readonly kind: 'create' }
	/**
	 * Whatever is there is replaced. `exists` says whether the plan found a
	 * file, so a failure leaves that file there and removes only one this
	 * write made.
	 */
	| { readonly kind: 'overwrite'; readonly exists: boolean };

/** What a write to `target` expects at its path when its bytes land. */
function expectationOf(target: WriteTarget): Expectation {
	if (target.kind === 'create') return 'absent';
	if (target.kind === 'overwrite') return 'any';
	return target.expectedSha256 === undefined
		? 'present'
		: { sha256: target.expectedSha256 };
}

/**
 * A host's refusal of what a change expected, as file storage reports it.
 * The host changed nothing. A refusal the expectation could not produce is
 * reported as a failure of `operation`.
 */
function unexpected(
	refusal: UnexpectedTarget,
	path: string,
	operation: string,
	expectedSha256: string | undefined,
): Result<never, FileError> {
	const { found } = refusal;
	if (found.name === 'Exists') return FileError.Exists({ path });
	if (expectedSha256 !== undefined)
		return FileError.Conflict({
			path,
			expectedSha256,
			actualSha256: found.name === 'Conflict' ? found.actualSha256 : undefined,
		});
	if (found.name === 'NotFound') return FileError.NotFound({ path });
	return FileError.Io({ path, operation, cause: refusal });
}

/** One step of an application whose conditions held. */
type Planned =
	| {
			readonly kind: 'write';
			readonly path: string;
			readonly bytes: Uint8Array;
			readonly sha256: string;
			readonly target: WriteTarget;
	  }
	| {
			readonly kind: 'remove';
			readonly path: string;
			readonly expectedSha256: string | undefined;
	  }
	| {
			readonly kind: 'move';
			readonly from: string;
			readonly to: string;
			readonly bytes: Uint8Array;
			readonly sha256: string;
	  };

function toStep(change: FileChange): FileStep {
	return change.kind === 'move'
		? { kind: 'move', from: change.from, to: change.to }
		: {
				kind: change.kind === 'remove' ? 'remove' : 'write',
				path: change.path,
			};
}

const stepPaths = (step: FileStep): string[] =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

/**
 * Check every change's condition against the folder as earlier changes of the
 * same application leave it. Nothing is written.
 */
async function plan(
	root: OpfsDirectoryHandle,
	changes: readonly FileChange[],
): Promise<Result<Planned[], FileError>> {
	/** Files earlier steps write (their SHA-256) or remove (`null`). */
	const overlay = new Map<string, string | null>();
	/** Bytes read from the folder while checking, by path. */
	const read = new Map<string, Uint8Array>();

	type Current =
		| { kind: 'file'; sha256: string | undefined }
		| { kind: 'directory' }
		| { kind: 'absent' }
		| { kind: 'occupied' }
		| { kind: 'link' }
		| { kind: 'underFile'; ancestor: string };

	/** `hash: false` answers whether a file is there without reading it. */
	async function current(path: string, hash = true): Promise<Current> {
		const written = overlay.get(path);
		if (written !== undefined)
			return written === null
				? { kind: 'absent' }
				: { kind: 'file', sha256: written };
		for (const parent of ancestors(path))
			if (typeof overlay.get(parent) === 'string')
				return { kind: 'underFile', ancestor: parent };
		for (const [other, value] of overlay)
			if (value !== null && other.startsWith(`${path}/`))
				return { kind: 'directory' };
		const found = await lookup(root, path);
		if (found.kind === 'underFile')
			// An earlier step may have removed the file in the way.
			return overlay.get(found.ancestor) === null ? { kind: 'absent' } : found;
		if (found.kind !== 'file') return found;
		if (!hash) return { kind: 'file', sha256: undefined };
		const bytes = await readHandle(found.handle);
		read.set(path, bytes);
		return { kind: 'file', sha256: await hashBytes(bytes) };
	}

	/** A file may be written at `path` where no file is. */
	function blocked(path: string, found: Current): FileError | undefined {
		if (found.kind === 'directory') return FileError.NotAFile({ path }).error;
		if (found.kind === 'occupied') return FileError.Exists({ path }).error;
		if (found.kind === 'link') return linkRefusal(path).error;
		if (found.kind === 'underFile')
			return FileError.NotADirectory({ path: found.ancestor }).error;
		return undefined;
	}

	function conflict(
		path: string,
		found: Current,
		expectedSha256: string | undefined,
	): FileError | undefined {
		const actual = found.kind === 'file' ? found.sha256 : undefined;
		if (expectedSha256 === undefined || actual === expectedSha256)
			return undefined;
		return FileError.Conflict({
			path,
			expectedSha256,
			actualSha256: actual,
		}).error;
	}

	const planned: Planned[] = [];
	try {
		for (const change of changes) {
			if (change.kind === 'remove') {
				const found = await current(
					change.path,
					change.expectedSha256 !== undefined,
				);
				if (found.kind === 'directory')
					return FileError.NotAFile({ path: change.path });
				if (found.kind === 'link') return linkRefusal(change.path);
				if (found.kind !== 'file')
					return FileError.NotFound({ path: change.path });
				const refused = conflict(change.path, found, change.expectedSha256);
				if (refused) return Err(refused);
				overlay.set(change.path, null);
				planned.push({
					kind: 'remove',
					path: change.path,
					expectedSha256: change.expectedSha256,
				});
				continue;
			}
			if (change.kind === 'move') {
				const found = await current(change.from);
				if (found.kind === 'directory')
					return FileError.NotAFile({ path: change.from });
				if (found.kind === 'link') return linkRefusal(change.from);
				if (found.kind !== 'file' || found.sha256 === undefined)
					return FileError.NotFound({ path: change.from });
				const refused = conflict(change.from, found, change.expectedSha256);
				if (refused) return Err(refused);
				// A source an earlier step wrote has that step's bytes.
				const earlier = planned.findLast(
					(step) =>
						(step.kind === 'write' && step.path === change.from) ||
						(step.kind === 'move' && step.to === change.from),
				);
				const bytes =
					earlier !== undefined && earlier.kind !== 'remove'
						? earlier.bytes
						: read.get(change.from);
				if (bytes === undefined)
					return FileError.NotFound({ path: change.from });
				const destination = await current(change.to, false);
				if (destination.kind === 'file')
					return FileError.Exists({ path: change.to });
				const refusedTo = blocked(change.to, destination);
				if (refusedTo) return Err(refusedTo);
				overlay.set(change.from, null);
				overlay.set(change.to, found.sha256);
				planned.push({
					kind: 'move',
					from: change.from,
					to: change.to,
					bytes,
					sha256: found.sha256,
				});
				continue;
			}
			// Only a guarded replacement compares bytes; the others need not read them.
			const found = await current(
				change.path,
				change.kind === 'replace' && change.expectedSha256 !== undefined,
			);
			if (change.kind === 'create' && found.kind === 'file')
				return FileError.Exists({ path: change.path });
			if (change.kind === 'replace') {
				const refused = conflict(change.path, found, change.expectedSha256);
				if (refused) return Err(refused);
				// A replacement never creates a file, guarded or not.
				if (found.kind === 'directory')
					return FileError.NotAFile({ path: change.path });
				if (found.kind !== 'file')
					return FileError.NotFound({ path: change.path });
			}
			if (found.kind !== 'file') {
				const refused = blocked(change.path, found);
				if (refused) return Err(refused);
			}
			overlay.set(change.path, change.sha256);
			planned.push({
				kind: 'write',
				path: change.path,
				bytes: change.bytes,
				sha256: change.sha256,
				target:
					change.kind === 'replace'
						? { kind: 'replace', expectedSha256: change.expectedSha256 }
						: change.kind === 'create'
							? { kind: 'create' }
							: { kind: 'overwrite', exists: found.kind === 'file' },
			});
		}
	} catch (cause) {
		return FileError.Io({ path: '', operation: 'read', cause });
	}
	return Ok(planned);
}

/**
 * Publish `bytes` at `path` as `target` requires. A stream that fails to
 * close is `Unconfirmed`, whatever the path holds afterward, unless its host
 * refused it for finding something other than `target` there
 * (`UnexpectedTarget`), which published nothing.
 */
export async function writeFileAt(
	root: OpfsDirectoryHandle,
	path: string,
	bytes: Uint8Array,
	target: WriteTarget,
): Promise<Result<undefined, FileError>> {
	const replace = target.kind === 'replace';
	const absent = () =>
		replace && target.expectedSha256 !== undefined
			? FileError.Conflict({
					path,
					expectedSha256: target.expectedSha256,
					actualSha256: undefined,
				})
			: FileError.NotFound({ path });
	let parent: OpfsDirectoryHandle;
	if (replace) {
		let found: Lookup;
		try {
			found = await lookup(root, parentOf(path));
		} catch (cause) {
			return FileError.Io({ path, operation: 'write', cause });
		}
		if (found.kind !== 'directory') return absent();
		parent = found.handle;
	} else {
		const { data: made, error: parentError } = await ensureDirectory(
			root,
			parentOf(path),
		);
		if (parentError !== null) return Err(parentError);
		parent = made;
	}
	const name = basename(path);
	let handle: OpfsFileHandle;
	try {
		handle = await parent.getFileHandle(name, { create: !replace });
	} catch (cause) {
		const problem = errorName(cause);
		if (problem === 'TypeMismatchError') return FileError.NotAFile({ path });
		if (replace && problem === 'NotFoundError') return absent();
		return FileError.Io({ path, operation: 'write', cause });
	}
	// A new file exists, empty, from here until its stream closes. A write
	// that cannot finish takes it away again, and says so only when the path
	// is then seen to be absent.
	const failed = async (cause: unknown) => {
		if (replace || (target.kind === 'overwrite' && target.exists))
			return FileError.Io({ path, operation: 'write', cause });
		try {
			await parent.removeEntry(name);
		} catch {
			// Whether it went is asked next.
		}
		try {
			await parent.getFileHandle(name);
		} catch (missing) {
			if (errorName(missing) === 'NotFoundError')
				return FileError.Io({ path, operation: 'write', cause });
		}
		return FileError.Unconfirmed({ path, operation: 'write', cause });
	};
	let writable: OpfsWritable;
	try {
		writable = await handle.createWritable({
			keepExistingData: false,
			expected: expectationOf(target),
		});
	} catch (cause) {
		if (replace && errorName(cause) === 'NotFoundError') return absent();
		return failed(cause);
	}
	if (replace) {
		// The stream may belong to a file removed since the handle was taken;
		// closing it would create the file again. While it is open, its lock
		// refuses a removal, so a file found now is there when it closes.
		try {
			await handle.getFile();
		} catch (cause) {
			await writable.abort().catch(() => {});
			if (errorName(cause) === 'NotFoundError') return absent();
			return FileError.Io({ path, operation: 'write', cause });
		}
	}
	try {
		await writable.write(bytes as Uint8Array<ArrayBuffer>);
	} catch (cause) {
		await writable.abort().catch(() => {});
		return failed(cause);
	}
	try {
		await writable.close();
	} catch (cause) {
		if (cause instanceof UnexpectedTarget)
			return unexpected(
				cause,
				path,
				'write',
				replace ? target.expectedSha256 : undefined,
			);
		// The close may have published these bytes or not. Bytes read now,
		// even the submitted ones, say what the path holds, not which write
		// put them there.
		return FileError.Unconfirmed({ path, operation: 'write', cause });
	}
	return Ok(undefined);
}

/**
 * After Git removed `path`, remove the directories that removal left empty,
 * nearest first. A directory that still holds anything stays, and so does
 * every directory above it.
 */
async function pruneEmptied(root: OpfsDirectoryHandle, path: string) {
	for (const directory of ancestors(path).reverse()) {
		const found = await lookup(root, directory);
		if (found.kind !== 'directory') return;
		for await (const _ of found.handle.values()) return;
		const parent = await lookup(root, parentOf(directory));
		if (parent.kind !== 'directory') return;
		await parent.handle.removeEntry(basename(directory));
	}
}

/** Remove the file at `path`; with `expectedSha256`, only if it holds those bytes. */
export async function removeFileAt(
	root: OpfsDirectoryHandle,
	path: string,
	expectedSha256?: string,
): Promise<Result<undefined, FileError>> {
	try {
		const parent = await lookup(root, parentOf(path));
		if (parent.kind !== 'directory') return FileError.NotFound({ path });
		await parent.handle.removeEntry(
			basename(path),
			expectedSha256 === undefined
				? undefined
				: { expected: { sha256: expectedSha256 } },
		);
		return Ok(undefined);
	} catch (cause) {
		if (cause instanceof UnexpectedTarget)
			return unexpected(cause, path, 'remove', expectedSha256);
		if (errorName(cause) === 'NotFoundError')
			return FileError.NotFound({ path });
		if (cause instanceof UnconfirmedWrite)
			return FileError.Unconfirmed({ path, operation: 'remove', cause });
		return FileError.Io({ path, operation: 'remove', cause });
	}
}

/**
 * Perform planned steps in order, calling `landed` after each one. A failure
 * after a step landed is `Partial`. With `prune`, as Git's removals do, a
 * removal also removes the directories it left empty.
 */
async function perform(
	root: OpfsDirectoryHandle,
	changes: readonly FileChange[],
	planned: readonly Planned[],
	landed: (paths: readonly string[]) => void,
	prune: boolean,
): Promise<Result<undefined, FileError | ApplyError>> {
	const applied: FileStep[] = [];
	for (let index = 0; index < planned.length; index++) {
		const step = planned[index]!;
		const reached: FileStep[] = [];
		let result: Result<undefined, FileError>;
		if (step.kind === 'write')
			result = await writeFileAt(root, step.path, step.bytes, step.target);
		else if (step.kind === 'remove') {
			result = await removeFileAt(root, step.path, step.expectedSha256);
			if (result.error === null && prune)
				try {
					await pruneEmptied(root, step.path);
				} catch {
					// An empty directory that stays is still a directory a later
					// write refuses as `NotAFile`; that refusal is the report.
				}
		} else {
			// No portable OPFS move exists, so a move writes the destination,
			// then retires the source. Between them both paths hold the bytes.
			// The source is retired only if it still holds the bytes moved.
			result = await writeFileAt(root, step.to, step.bytes, {
				kind: 'create',
			});
			if (result.error === null) {
				reached.push({ kind: 'write', path: step.to });
				landed([step.to]);
				result = await removeFileAt(root, step.from, step.sha256);
			}
		}
		const { error: stepError } = result;
		if (stepError !== null) {
			// An unknown outcome may have changed the path: say so.
			if (stepError.name === 'Unconfirmed')
				landed(step.kind === 'move' ? [step.to] : [step.path]);
			const all = [...applied, ...reached];
			if (all.length === 0) return Err(stepError);
			return ApplyError.Partial({
				applied: all,
				failed:
					step.kind === 'move' && reached.length > 0
						? { kind: 'remove', path: step.from }
						: toStep(changes[index]!),
				error: stepError,
				notAttempted: changes.slice(index + 1).map(toStep),
			});
		}
		const done = toStep(changes[index]!);
		applied.push(done);
		landed(step.kind === 'move' ? [step.from] : stepPaths(done));
	}
	return Ok(undefined);
}

/**
 * Check, then apply, already hashed changes under the files lock the caller
 * holds. The boundary and incoming Git publication both publish through it;
 * Git passes `prune` so a tree that turns a directory into a file can land.
 */
export async function applyChanges(
	root: OpfsDirectoryHandle,
	changes: readonly FileChange[],
	landed: (paths: readonly string[]) => void,
	{ prune = false }: { prune?: boolean } = {},
): Promise<Result<undefined, FileError | ApplyError>> {
	const { data: planned, error: planError } = await plan(root, changes);
	if (planError !== null) return Err(planError);
	return perform(root, changes, planned, landed, prune);
}

const changePaths = (change: FileChange) =>
	change.kind === 'move' ? [change.from, change.to] : [change.path];

function invalid(path: string): Result<never, FileError> | undefined {
	const problem = pathProblem(path);
	return problem === undefined
		? undefined
		: FileError.InvalidPath({ path, reason: problem });
}

export function createOpfsFileBoundary({
	root,
	locks,
	filesLock,
	landed,
}: {
	/** The folder's directory. */
	root: OpfsDirectoryHandle;
	locks: OpfsLocks;
	/** The Web Lock every mutation of this folder holds. */
	filesLock: string;
	/** Paths one landed step reached, as soon as it lands. */
	landed: (paths: readonly string[]) => void;
}): FileBoundary {
	/** Every mutation runs under the files lock. */
	const mutate = <T>(work: () => Promise<T>) => holding(locks, filesLock, work);

	async function readOne(path: string): Promise<Result<FileRead, FileError>> {
		try {
			const found = await lookup(root, path);
			if (found.kind === 'directory') return FileError.NotAFile({ path });
			if (found.kind === 'link') return linkRefusal(path);
			if (found.kind !== 'file') return FileError.NotFound({ path });
			const bytes = await readHandle(found.handle);
			return Ok({ bytes, sha256: await hashBytes(bytes) });
		} catch (cause) {
			if (isLink(cause)) return linkRefusal(path);
			if (errorName(cause) === 'NotFoundError')
				return FileError.NotFound({ path });
			return FileError.Io({ path, operation: 'read', cause });
		}
	}

	return {
		async list() {
			const files: { path: string; size: number }[] = [];
			const directories: string[] = [];
			try {
				await walk(root, '', {
					async file(path, handle) {
						try {
							files.push({ path, size: (await handle.getFile()).size });
						} catch (cause) {
							// A link is listed, so reading it reports why it is unusable.
							if (isLink(cause)) files.push({ path, size: 0 });
							else if (errorName(cause) !== 'NotFoundError') throw cause;
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
				const found = await lookup(root, directory);
				if (found.kind === 'file')
					return FileError.NotADirectory({ path: directory });
				if (found.kind === 'link') return linkRefusal(directory);
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
		async readMany(paths) {
			const results = new Map<string, Result<FileRead, FileError>>();
			for (const path of paths)
				results.set(path, invalid(path) ?? (await readOne(path)));
			return Ok(results);
		},
		async open(path) {
			// The bytes are copied into memory: a `File` from `getFile` stops
			// reading once the path is replaced, and this Blob must not.
			const refused = invalid(path);
			if (refused) return refused;
			const { data: read, error: readError } = await readOne(path);
			if (readError !== null) return Err(readError);
			return Ok(new Blob([read.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			for (const path of changes.flatMap(changePaths)) {
				const refused = invalid(path);
				if (refused) return refused;
			}
			if (changes.length === 0) return Ok(undefined);
			return mutate(() => applyChanges(root, changes, landed));
		},
		async mkdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			return mutate(async () => {
				const made = await ensureDirectory(root, path);
				return made.error !== null ? made : Ok(undefined);
			});
		},
		async rmdir(path) {
			const refused = invalid(path);
			if (refused) return refused;
			return mutate(async (): Promise<Result<undefined, FileError>> => {
				try {
					const found = await lookup(root, path);
					if (found.kind === 'file') return FileError.NotADirectory({ path });
					if (found.kind !== 'directory') return FileError.NotFound({ path });
					for await (const _ of found.handle.values())
						return FileError.DirectoryNotEmpty({ path });
					const parent = await lookup(root, parentOf(path));
					if (parent.kind !== 'directory') return FileError.NotFound({ path });
					await parent.handle.removeEntry(basename(path));
					return Ok(undefined);
				} catch (cause) {
					const name = errorName(cause);
					if (name === 'InvalidModificationError')
						return FileError.DirectoryNotEmpty({ path });
					if (name === 'NotFoundError') return FileError.NotFound({ path });
					if (cause instanceof UnconfirmedWrite)
						return FileError.Unconfirmed({
							path,
							operation: 'remove directory',
							cause,
						});
					return FileError.Io({ path, operation: 'remove directory', cause });
				}
			});
		},
		async capture() {
			try {
				return Ok(await captureFiles(root));
			} catch (cause) {
				return FileError.Io({ path: '', operation: 'capture', cause });
			}
		},
	};
}
