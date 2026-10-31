/**
 * The dedicated Worker that owns a browser device's files in this origin's
 * private file system (OPFS), started by `opfs-store.ts` (decision 55).
 * Every list, read, and change runs here, off the page's thread.
 *
 * A change holds a Web Lock named for its path while it checks the version
 * its writer expects and lands, so two tabs' writers to one path take turns.
 * Both engines otherwise let two writables on one file race, and the last
 * `close()` silently wins (opfs-probe/RESULTS.md).
 *
 * - A replacement writes through `createWritable()`, which keeps the old
 *   bytes visible until `close()` and keeps them on `abort()`.
 * - A new file is written whole under `.epicenter/staging/` and moved to its
 *   path with `move(parentDirectory, name)`, the one form both engines take,
 *   so it never appears empty first, and a crash leaves no empty file at the
 *   path.
 *
 * Every change that lands is posted on the `epicenter-device` broadcast
 * channel (`{ paths, from }`), so the stores of other tabs hear it; `from`
 * names the store that asked, which skips its own.
 *
 * This file imports nothing, so any bundler can ship it as a Worker.
 */

type Request =
	| { id: number; op: 'list' }
	| { id: number; op: 'read'; path: string }
	| {
			id: number;
			op: 'write';
			path: string;
			bytes: Uint8Array | null;
			expected: string;
			from: string;
	  };

/** What the worker posts on `CHANGES` for each change that lands. */
export type Changed = { paths: string[]; from: string };

/** The broadcast channel every device store and worker of this origin shares (`opfs-store.ts` names it too). */
const CHANGES = 'epicenter-device';

export type Reply =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; refused: boolean; name: string; message: string };

/** The iteration TypeScript's DOM library leaves out of the directory handle. */
type Directory = FileSystemDirectoryHandle & {
	entries(): AsyncIterable<[string, FileSystemHandle]>;
};
type MovableFile = FileSystemFileHandle & {
	move(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
};

const STAGING = ['.epicenter', 'staging'];
/** How old a staged file must be before it is swept: its writer stopped. */
const STALE_STAGING_MS = 60 * 60 * 1000;

/** `getDirectory()` refused: this browser gives the page no private storage. */
class Refused extends Error {}

let rootPromise: Promise<FileSystemDirectoryHandle> | undefined;

function root() {
	rootPromise ??= navigator.storage.getDirectory().then(
		async (directory) => {
			await sweepStaging(directory).catch(() => {});
			return directory;
		},
		(cause: unknown) => {
			rootPromise = undefined;
			throw new Refused(describe(cause), { cause });
		},
	);
	return rootPromise;
}

const describe = (cause: unknown) =>
	cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

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

async function sha256(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	let hex = '';
	for (const byte of new Uint8Array(digest))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}

const stampOf = (file: File) => `${file.size}:${file.lastModified}`;

/**
 * Whether reading `name` in `directory` failed because the entry went
 * meanwhile: this device's own writes move and delete files while a listing
 * or a read runs. Chromium says `NotFoundError`; WebKit says
 * `NotReadableError` for a file removed during its read, so that one counts
 * only when the entry is in fact gone.
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

/**
 * Every file, with its stamp. Writes run beside a listing, so an entry can
 * go between being named and being read (another tab deletes it while this
 * one lists): it is skipped, as a listing a moment later would
 * skip it, rather than failing the whole listing.
 */
async function list() {
	const files: { path: string; stamp: string }[] = [];
	async function walk(directory: FileSystemDirectoryHandle, prefix: string) {
		try {
			for await (const [name, handle] of (directory as Directory).entries()) {
				const path = `${prefix}${name}`;
				if (handle.kind === 'directory') {
					await walk(handle as FileSystemDirectoryHandle, `${path}/`);
					continue;
				}
				try {
					files.push({
						path,
						stamp: stampOf(await (handle as FileSystemFileHandle).getFile()),
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
	return files.filter(({ path }) => !path.startsWith(`${STAGING.join('/')}/`));
}

/** The file at `path`, or null when it is not there, deleted mid-read included. */
async function read(path: string) {
	const found = await fileAt(path);
	if (found === null) return null;
	let file: File;
	let bytes: Uint8Array;
	try {
		file = await found.handle.getFile();
		bytes = new Uint8Array(await file.arrayBuffer());
	} catch (cause) {
		if (await went(cause, found.parent, found.name)) return null;
		throw cause;
	}
	return { bytes, version: await sha256(bytes), stamp: stampOf(file) };
}

async function write(path: string, bytes: Uint8Array | null, expected: string) {
	segmentsOf(path);
	return navigator.locks.request(`epicenter-device:${path}`, async () => {
		// `'any'` (a cache) holds whatever is there, so nothing is read.
		const current = expected === 'any' ? null : await read(path);
		const holds =
			expected === 'any' ||
			(expected === 'absent'
				? current === null
				: current?.version === expected);
		if (!holds) return 'stale';
		if (bytes === null) {
			const found = await fileAt(path);
			if (found !== null) await found.parent.removeEntry(found.name);
			return 'landed';
		}
		if (current !== null || expected === 'any') {
			const found = await fileAt(path);
			if (found !== null) {
				await writeWhole(found.handle, bytes);
				return 'landed';
			}
			if (current !== null) return 'stale';
		}
		const segments = segmentsOf(path);
		const name = segments.pop()!;
		const directory = await root();
		const parent = (await directoryAt(directory, segments, true))!;
		const staging = (await directoryAt(directory, STAGING, true))!;
		const stagedName = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
		const staged = await staging.getFileHandle(stagedName, { create: true });
		try {
			await writeWhole(staged, bytes);
			await (staged as MovableFile).move(parent, name);
		} catch (cause) {
			await staging.removeEntry(stagedName).catch(() => {});
			throw cause;
		}
		return 'landed';
	});
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

/** Remove staged files a stopped write left an hour or more ago. */
async function sweepStaging(directory: FileSystemDirectoryHandle) {
	const staging = await directoryAt(directory, STAGING, false);
	if (staging === null) return;
	const now = Date.now();
	for await (const [name, handle] of (staging as Directory).entries()) {
		const created = Number.parseInt(name.split('-')[0] ?? '', 36);
		if (handle.kind === 'file' && now - created > STALE_STAGING_MS)
			await staging.removeEntry(name).catch(() => {});
	}
}

let changes: BroadcastChannel | undefined;

/** Tell every other store of this origin that `path` changed. */
function announce(path: string, from: string) {
	if (typeof BroadcastChannel === 'undefined') return;
	changes ??= new BroadcastChannel(CHANGES);
	changes.postMessage({ paths: [path], from } satisfies Changed);
}

async function answer(request: Request): Promise<unknown> {
	switch (request.op) {
		case 'list':
			return list();
		case 'read':
			return read(request.path);
		case 'write': {
			const outcome = await write(
				request.path,
				request.bytes,
				request.expected,
			);
			if (outcome === 'landed') announce(request.path, request.from);
			return outcome;
		}
		default:
			return request satisfies never;
	}
}

addEventListener('message', async (event) => {
	const request = (event as MessageEvent<Request>).data;
	let reply: Reply;
	const transfer: Transferable[] = [];
	try {
		const value = await answer(request);
		reply = { id: request.id, ok: true, value };
		if (request.op === 'read' && value !== null)
			transfer.push((value as { bytes: Uint8Array }).bytes.buffer);
	} catch (cause) {
		reply = {
			id: request.id,
			ok: false,
			refused: cause instanceof Refused,
			name: cause instanceof Error ? cause.name : 'Error',
			message: describe(cause),
		};
	}
	postMessage(reply, { transfer });
});
