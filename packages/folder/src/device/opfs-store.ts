/**
 * A device store over this origin's private file system (OPFS), called from
 * the page itself (ADR-0784): every list, read and write uses the
 * asynchronous file handles a window has (`getFile`, `createWritable`,
 * `move`), so no worker stands between the page and its files.
 *
 * A write holds a Web Lock named for its path while it checks the version
 * its writer expects and lands, so two tabs' writers to one path take turns.
 * Both engines otherwise let two writables on one file race, and the last
 * `close()` silently wins (opfs-probe/RESULTS.md).
 *
 * - A replacement writes through `createWritable()`, which keeps the old
 *   bytes visible until `close()` and keeps them on `abort()`.
 * - A new file is written whole under `.epicenter/saves/` and moved to its
 *   path with `move(parentDirectory, name)`, the one form both engines take,
 *   so it never appears empty first, and a crash leaves no empty file at the
 *   path.
 *
 * Every change that lands is posted on the `epicenter-device` broadcast
 * channel (`{ paths, from }`), so the stores of other tabs hear it; `from`
 * names the store that wrote, which skips its own.
 *
 * A browser that gives the page no private storage, as WebKit does in an
 * ephemeral context, refuses `getDirectory()`: each call is then
 * `Unavailable`, its cause a `DeviceError.StorageRefused`, never a throw
 * (`browser.ts` fails the open first). OPFS is evictable (`persist()` was
 * false in every headless probe): a local web variant's files are this
 * browser's alone (ADR-0700), and live as long as the browser keeps them.
 */
import { ClientError } from '@epicenter/definition/contract';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { hashBytes } from '../hash.js';
import { isStaleSave, SAVES, STATE_DIRECTORY, scratchName } from '../state.js';
import {
	type Changed,
	type FileRead,
	type Listed,
	type Store,
	type Version,
	versionedByContent,
	within,
} from './store.js';

/** The broadcast channel every device store of this origin shares. */
const CHANGES = 'epicenter-device';

/** What a store posts on `CHANGES` for each change that lands. */
type Broadcast = { paths: string[]; from: string };

export const DeviceError = defineErrors({
	/** The browser gives this page no private file storage (`navigator.storage.getDirectory()` rejected). */
	StorageRefused: ({ cause }: { cause: unknown }) => ({
		message: `This browser gives the page no private file storage: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** The store was closed: its folder was disposed. */
	Closed: () => ({ message: "This browser's storage was closed" }),
});
export type DeviceError = InferErrors<typeof DeviceError>;

/** The iteration TypeScript's DOM library leaves out of the directory handle. */
type Directory = FileSystemDirectoryHandle & {
	entries(): AsyncIterable<[string, FileSystemHandle]>;
};
type MovableFile = FileSystemFileHandle & {
	move(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
};

/** Where a new file is staged: `.epicenter/saves`. */
const STAGING = [STATE_DIRECTORY, SAVES];

/** `getDirectory()` refused: this browser gives the page no private storage. */
class Refused extends Error {}

/** Whether `cause` says the entry is not there, or is not of the kind asked for. */
const isMissing = (cause: unknown) =>
	cause instanceof DOMException &&
	(cause.name === 'NotFoundError' || cause.name === 'TypeMismatchError');

function segmentsOf(path: string) {
	const segments = path.split('/');
	if (segments.some((segment) => ['', '.', '..'].includes(segment)))
		throw new Error(`'${path}' is not a relative file path`);
	return segments;
}

/** The directory at `segments` below `from`, made when `create`; null when it is not there. */
async function directoryAt(
	from: FileSystemDirectoryHandle,
	segments: string[],
	create: boolean,
) {
	let directory = from;
	for (const segment of segments) {
		try {
			directory = await directory.getDirectoryHandle(segment, { create });
		} catch (cause) {
			if (isMissing(cause)) return null;
			throw cause;
		}
	}
	return directory;
}

const stampOf = (file: File) => `${file.size}:${file.lastModified}`;

/** The version of `file` at `path`, read from its bytes only for a note. */
async function versionOf(path: string, file: File, bytes?: Uint8Array) {
	if (!versionedByContent(path)) return stampOf(file);
	return hashBytes(bytes ?? new Uint8Array(await file.arrayBuffer()));
}

/**
 * Whether reading `name` in `directory` failed because the entry went
 * meanwhile: writes move and delete files while a listing or a read runs.
 * Chromium says `NotFoundError`; WebKit says `NotReadableError` for a file
 * removed during its read, so that one counts only when the entry is in
 * fact gone.
 */
async function went(
	cause: unknown,
	directory: FileSystemDirectoryHandle,
	name: string,
) {
	if (isMissing(cause)) return true;
	if (!(cause instanceof DOMException) || cause.name !== 'NotReadableError')
		return false;
	try {
		await directory.getFileHandle(name);
		return false;
	} catch (missing) {
		return isMissing(missing);
	}
}

/** Whether a read failed only because the file changed under it: it is still there. */
async function changedMidRead(
	cause: unknown,
	{ parent, name }: { parent: FileSystemDirectoryHandle; name: string },
) {
	if (
		!(cause instanceof DOMException) ||
		(cause.name !== 'NotReadableError' && cause.name !== 'NotFoundError')
	)
		return false;
	try {
		await parent.getFileHandle(name);
		return true;
	} catch {
		return false;
	}
}

async function writeWhole(handle: FileSystemFileHandle, bytes: Uint8Array) {
	const writable = await handle.createWritable();
	try {
		await writable.write(bytes as Uint8Array<ArrayBuffer>);
	} catch (cause) {
		await writable.abort().catch(() => {});
		throw cause;
	}
	await writable.close();
}

/**
 * Remove the staged files a stopped write left an hour or more ago: files
 * with a staged name (`isStaleSave`), nothing else.
 */
async function sweepSaves(directory: FileSystemDirectoryHandle) {
	const saves = await directoryAt(directory, STAGING, false);
	if (saves === null) return;
	const now = Date.now();
	for await (const [name, handle] of (saves as Directory).entries()) {
		if (handle.kind === 'file' && isStaleSave(name, now))
			await saves.removeEntry(name).catch(() => {});
	}
}

/** The store over this origin's private files. */
export function opfsStore(): Store {
	let closed = false;
	/** Names this store's writes on the broadcast channel, to skip them there. */
	const writer = crypto.randomUUID();
	let announcer: BroadcastChannel | undefined;
	let rootPromise: Promise<FileSystemDirectoryHandle> | undefined;

	/** This origin's private directory, swept of stale saves the first time. */
	function root() {
		rootPromise ??= Promise.resolve()
			.then(() => navigator.storage.getDirectory())
			.then(
				async (directory) => {
					await sweepSaves(directory).catch(() => {});
					return directory;
				},
				(cause: unknown) => {
					rootPromise = undefined;
					throw new Refused(extractErrorMessage(cause), { cause });
				},
			);
		return rootPromise;
	}

	async function fileAt(path: string) {
		const segments = segmentsOf(path);
		const name = segments.pop()!;
		const parent = await directoryAt(await root(), segments, false);
		if (parent === null) return null;
		try {
			return { parent, name, handle: await parent.getFileHandle(name) };
		} catch (cause) {
			if (isMissing(cause)) return null;
			throw cause;
		}
	}

	/**
	 * Every file at or below each of `under`, with its version and size,
	 * hidden ones included (a staged write too): whoever reads a listing
	 * skips them. An entry that goes between being named and being read
	 * (another tab deletes it while this one lists) is skipped, as a listing
	 * a moment later would skip it, rather than failing the whole listing.
	 */
	async function list(under: readonly string[]) {
		const files: Listed[] = [];
		async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
			try {
				for await (const [name, handle] of (
					directory as Directory
				).entries()) {
					const path = `${prefix}${name}`;
					if (handle.kind === 'directory') {
						// A directory no path asked for lies below is not walked.
						if (
							under.some(
								(wanted) =>
									wanted === '' ||
									within(path, [wanted]) ||
									wanted.startsWith(`${path}/`),
							)
						)
							await walk(handle as FileSystemDirectoryHandle, `${path}/`);
						continue;
					}
					if (!within(path, under)) continue;
					try {
						const file = await (handle as FileSystemFileHandle).getFile();
						files.push({
							path,
							version: (await versionOf(path, file)) as Version,
							size: file.size,
						});
					} catch (cause) {
						if (!(await went(cause, directory, name))) throw cause;
					}
				}
			} catch (cause) {
				// The directory itself went (its last file moved or was deleted).
				if (!isMissing(cause)) throw cause;
			}
		}
		await walk(await root(), '');
		return files;
	}

	/** The file at `path`, or null when it is not there, deleted mid-read included. */
	async function read(path: string) {
		for (let attempt = 1; ; attempt++) {
			const found = await fileAt(path);
			if (found === null) return null;
			try {
				const file = await found.handle.getFile();
				const bytes = new Uint8Array(await file.arrayBuffer());
				return {
					bytes,
					version: (await versionOf(path, file, bytes)) as Version,
				};
			} catch (cause) {
				// A write between taking the file and reading its bytes leaves a
				// snapshot that no longer reads while the file is still there:
				// read again.
				if (attempt < 3 && (await changedMidRead(cause, found))) continue;
				if (await went(cause, found.parent, found.name)) return null;
				throw cause;
			}
		}
	}

	/** Make the file at `path` with `bytes`, staged and moved so it never appears empty. */
	async function createWhole(path: string, bytes: Uint8Array) {
		const segments = segmentsOf(path);
		const name = segments.pop()!;
		const directory = await root();
		const parent = (await directoryAt(directory, segments, true))!;
		const saves = (await directoryAt(directory, STAGING, true))!;
		const stagedAs = scratchName();
		const file = await saves.getFileHandle(stagedAs, { create: true });
		try {
			await writeWhole(file, bytes);
			await (file as MovableFile).move(parent, name);
		} catch (cause) {
			await saves.removeEntry(stagedAs).catch(() => {});
			throw cause;
		}
	}

	/**
	 * Write `bytes` at `path`, or remove the file for null, only while it
	 * holds `over` (`'absent'`: nothing): the version that landed, null for
	 * a removal, or `'stale'`.
	 */
	async function write(
		path: string,
		bytes: Uint8Array | null,
		over: Version | 'absent',
	) {
		segmentsOf(path);
		return navigator.locks.request(`epicenter-device:${path}`, async () => {
			const current = await read(path);
			const holds =
				over === 'absent' ? current === null : current?.version === over;
			if (!holds) return 'stale' as const;
			if (bytes === null) {
				const found = await fileAt(path);
				if (found !== null) await found.parent.removeEntry(found.name);
				return null;
			}
			if (current !== null) {
				const found = await fileAt(path);
				if (found === null) return 'stale' as const;
				await writeWhole(found.handle, bytes);
			} else await createWhole(path, bytes);
			// Under the lock, what is there now is what this write made.
			const landed = await fileAt(path);
			if (landed === null) throw new Error(`${path} went while it was written`);
			return (await versionOf(
				path,
				await landed.handle.getFile(),
				bytes,
			)) as Version;
		});
	}

	/** Tell every other store of this origin that `path` changed. */
	function announce(path: string) {
		if (typeof BroadcastChannel === 'undefined') return;
		announcer ??= new BroadcastChannel(CHANGES);
		announcer.postMessage({ paths: [path], from: writer } satisfies Broadcast);
	}

	/** Run `work`, answering what it threw, or a closed store, as `Unavailable`. */
	async function attempt<T>(work: () => Promise<T>) {
		if (closed) return ClientError.Unavailable({ cause: DeviceError.Closed().error });
		try {
			return Ok(await work());
		} catch (cause) {
			return ClientError.Unavailable({
				cause:
					cause instanceof Refused
						? DeviceError.StorageRefused({ cause: cause.message }).error
						: cause,
			});
		}
	}

	return {
		list: (under) => attempt(() => list(under)),
		read: (paths) =>
			attempt(() =>
				Promise.all(
					paths.map(async (path): Promise<FileRead> => {
						const found = await read(path);
						return found === null ? { path, gone: true } : { path, ...found };
					}),
				),
			),
		write: (path, bytes, over) =>
			attempt(async () => {
				const outcome = await write(path, bytes, over);
				if (outcome !== 'stale') announce(path);
				return outcome;
			}),
		// The channel is open once made: a change another tab lands after this
		// answers is heard, and only after that tab landed it.
		async watch(changed: Changed) {
			if (typeof BroadcastChannel === 'undefined') return Ok(() => {});
			const channel = new BroadcastChannel(CHANGES);
			channel.onmessage = ({ data }: MessageEvent<Broadcast>) => {
				if (data?.from !== writer)
					changed(Array.isArray(data?.paths) ? data.paths : 'all');
			};
			return Ok(() => channel.close());
		},
		close() {
			closed = true;
			announcer?.close();
			announcer = undefined;
		},
	};
}
