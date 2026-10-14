/**
 * An OPFS directory handle over an ordinary directory on disk.
 *
 * The browser folder's file storage (`opfs-store.ts`) reads and writes
 * through `OpfsDirectoryHandle` alone. This module implements that interface
 * over a handful of file system primitives, so the same storage runs over a
 * real directory: the desktop app supplies the primitives through Tauri's fs
 * plugin, and tests supply them through `node:fs`. History over a real
 * directory is real Git (`git/native-backend.ts`), not the browser's.
 *
 * The handle keeps the OPFS behaviors the folder relies on:
 *
 * - A name of the wrong kind is `TypeMismatchError`; a missing one is
 *   `NotFoundError`; removing a directory that holds anything without
 *   `recursive` is `InvalidModificationError`.
 * - `getFileHandle(name, { create: true })` gives a handle to a missing
 *   file without making it. OPFS makes it empty at once; on a disk another
 *   program reads, an empty file is a claim (Git takes an empty object file
 *   for a real one), so here the path is reached only by the rename that
 *   publishes its bytes.
 * - A writable stream publishes its bytes only when it closes. The bytes are
 *   written to a scratch file under `.git/epicenter/scratch` and renamed over
 *   the path, so another program sees the old file or the new one, never
 *   part of either. Aborting publishes nothing.
 * - `getFile` reports the size it finds; its bytes are read when asked for,
 *   and are whatever the path holds then.
 *
 * Symbolic links and special entries are never followed. They are listed as
 * files whose `getFile` reports their size and whose bytes cannot be read, so
 * a listing names them and a read or capture refuses them.
 *
 * Guarantees are best effort against other programs, as on any disk: a
 * check and the write that follows are two steps.
 */
import type {
	OpfsDirectoryHandle,
	OpfsFile,
	OpfsFileHandle,
	OpfsWritable,
} from './opfs-store.js';

/** What one entry of a directory is, without following a link. */
export type EntryKind = 'file' | 'directory' | 'link' | 'other';

/**
 * The file system calls a directory handle needs. Paths are absolute and use
 * `/`. Every call rejects on failure; `lstat` resolves `undefined` for a
 * missing path instead.
 */
export type DirectoryPrimitives = {
	/** Names in `path` and what each is, without following links. */
	readDir(
		path: string,
	): Promise<readonly { readonly name: string; readonly kind: EntryKind }[]>;
	/**
	 * What `path` is, without following a final link, or `undefined` when
	 * absent. `mode` is the Unix permission bits where the platform has them.
	 * `name` is the final segment as the file system stores it, which differs
	 * from the one asked for only on a case-insensitive file system; a
	 * platform that cannot say leaves it out, and the handle lists the parent
	 * instead.
	 */
	lstat(path: string): Promise<
		| {
				readonly kind: EntryKind;
				readonly size: number;
				readonly mode?: number;
				readonly name?: string;
		  }
		| undefined
	>;
	readFile(path: string): Promise<Uint8Array>;
	/**
	 * Write `bytes` to `path`. With `createNew`, reject when anything is
	 * already there.
	 */
	writeFile(
		path: string,
		bytes: Uint8Array,
		options?: { readonly createNew?: boolean },
	): Promise<void>;
	/** Rename `from` to `to`, replacing a file at `to`. */
	rename(from: string, to: string): Promise<void>;
	/** Remove a file, an empty directory, or with `recursive` a whole tree. */
	remove(
		path: string,
		options?: { readonly recursive?: boolean },
	): Promise<void>;
	/** Make the directory at `path` and any missing ancestors. */
	mkdir(path: string): Promise<void>;
};

/** Where a stream stages its bytes before they replace the path. */
export const SCRATCH_DIRECTORY = '.git/epicenter/scratch';

/**
 * How old a staged file must be before an open removes it. A stream renames
 * its staged file right after writing it, so one this old was left by a write
 * that stopped (a crash, a quit). Younger ones may belong to another process
 * writing the same directory: a script and a desktop window share no lock.
 */
export const STALE_SCRATCH_MS = 60 * 60 * 1000;

/**
 * A staged file's name: its creation time and a per-call counter in base 36,
 * around the handle's random engine id, so two processes never pick the same
 * name. Only ASCII letters, digits, and `-`, which the desktop shell admits.
 */
const SCRATCH_NAME = /^([0-9a-z]+)-[0-9a-f]{32}-[0-9a-z]+$/;

/**
 * Whether the staged file `name` was made more than `STALE_SCRATCH_MS`
 * before `now`. A name a handle did not make is never stale.
 */
export function isStaleScratch(name: string, now = Date.now()): boolean {
	const time = SCRATCH_NAME.exec(name)?.[1];
	if (time === undefined) return false;
	const created = Number.parseInt(time, 36);
	return Number.isSafeInteger(created) && now - created > STALE_SCRATCH_MS;
}

const domError = (name: string, message: string) =>
	new DOMException(message, name);

const join = (parent: string, name: string) =>
	parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;

/**
 * A name a single directory entry can have. OPFS refuses the rest with
 * `TypeError`; so does this handle, so no name can climb out of the root.
 */
function checkName(name: string): void {
	if (name === '' || name === '.' || name === '..' || name.includes('/'))
		throw new TypeError(`'${name}' is not a valid entry name`);
}

/**
 * The directory at absolute path `root`, as an OPFS directory handle. The
 * directory must exist; nothing is created until a handle asks to.
 */
export function directoryHandle(
	primitives: DirectoryPrimitives,
	root: string,
): OpfsDirectoryHandle {
	let scratchCounter = 0;
	const engine = crypto.randomUUID().replaceAll('-', '');
	const scratchRoot = join(root, SCRATCH_DIRECTORY);
	const nextScratch = () =>
		join(
			scratchRoot,
			`${Date.now().toString(36)}-${engine}-${(scratchCounter++).toString(36)}`,
		);

	function fileHandle(path: string, name: string): OpfsFileHandle {
		return {
			kind: 'file',
			name,
			async getFile(): Promise<OpfsFile> {
				const found = await primitives.lstat(path);
				if (found === undefined)
					throw domError('NotFoundError', `'${path}' does not exist`);
				if (found.kind === 'directory')
					throw domError('TypeMismatchError', `'${path}' is a directory`);
				if (found.kind === 'link') throw linked(path);
				if (found.kind === 'other')
					return {
						size: found.size,
						arrayBuffer: () =>
							Promise.reject(
								domError(
									'TypeMismatchError',
									`'${path}' is not a regular file and is not followed`,
								),
							),
					};
				return {
					size: found.size,
					async arrayBuffer() {
						let bytes: Uint8Array;
						try {
							bytes = await primitives.readFile(path);
						} catch (cause) {
							if ((await primitives.lstat(path)) === undefined)
								throw domError('NotFoundError', `'${path}' does not exist`);
							throw cause;
						}
						return bytes.buffer.slice(
							bytes.byteOffset,
							bytes.byteOffset + bytes.byteLength,
						) as ArrayBuffer;
					},
				};
			},
			async createWritable(): Promise<OpfsWritable> {
				// Every caller replaces the whole file (`keepExistingData: false`).
				const chunks: Uint8Array[] = [];
				let settled = false;
				return {
					async write(data) {
						if (settled)
							throw domError('InvalidStateError', 'stream is closed');
						chunks.push(new Uint8Array(data));
					},
					async abort() {
						settled = true;
						chunks.length = 0;
					},
					async close() {
						if (settled)
							throw domError('InvalidStateError', 'stream is closed');
						settled = true;
						const size = chunks.reduce(
							(sum, chunk) => sum + chunk.byteLength,
							0,
						);
						const bytes = new Uint8Array(size);
						let offset = 0;
						for (const chunk of chunks) {
							bytes.set(chunk, offset);
							offset += chunk.byteLength;
						}
						chunks.length = 0;
						await primitives.mkdir(scratchRoot);
						const scratch = nextScratch();
						await primitives.writeFile(scratch, bytes, { createNew: true });
						try {
							await primitives.rename(scratch, path);
						} catch (cause) {
							await primitives.remove(scratch).catch(() => {});
							throw cause;
						}
					},
				};
			},
		};
	}

	/**
	 * A symbolic link is never followed, and never stands for what it points
	 * at: `NotFoundError` marked `link`, which the file storage reports as an
	 * unusable path.
	 */
	function linked(at: string) {
		return Object.assign(
			domError(
				'NotFoundError',
				`'${at}' is a symbolic link and is not followed`,
			),
			{ link: true },
		);
	}

	/**
	 * Refuse an entry `lstat` found under a case-variant of `child`: on a
	 * case-insensitive file system `plan.md` reaches `Plan.md`. A lookup gets
	 * `NotFoundError` marked `occupied`, so a read sees nothing there and a
	 * write refuses to land on the other file; asking to create it is
	 * `InvalidModificationError`.
	 */
	async function literally(
		parent: string,
		child: string,
		found: { readonly kind: EntryKind; readonly name?: string },
		options?: { readonly create?: boolean },
	): Promise<void> {
		if (found.kind === 'link' || found.kind === 'other') return;
		const stored =
			found.name !== undefined
				? found.name === child
				: (await primitives.readDir(parent)).some(
						(entry) => entry.name === child,
					);
		if (stored) return;
		const at = join(parent, child);
		if (options?.create)
			throw domError(
				'InvalidModificationError',
				`'${at}' is stored under another name`,
			);
		throw Object.assign(
			domError('NotFoundError', `'${at}' is stored under another name`),
			{ occupied: true },
		);
	}

	function directoryAt(path: string, name: string): OpfsDirectoryHandle {
		return {
			kind: 'directory',
			name,
			async getDirectoryHandle(child, options) {
				checkName(child);
				const at = join(path, child);
				const found = await primitives.lstat(at);
				if (found?.kind === 'link') throw linked(at);
				if (found !== undefined) await literally(path, child, found, options);
				if (found === undefined) {
					if (!options?.create)
						throw domError('NotFoundError', `'${at}' does not exist`);
					await primitives.mkdir(at);
				} else if (found.kind !== 'directory')
					throw domError('TypeMismatchError', `'${at}' is not a directory`);
				return directoryAt(at, child);
			},
			async getFileHandle(child, options) {
				checkName(child);
				const at = join(path, child);
				const found = await primitives.lstat(at);
				if (found?.kind === 'link') throw linked(at);
				if (found !== undefined) await literally(path, child, found, options);
				if (found === undefined) {
					// Nothing is written until the stream closes and its bytes
					// are renamed into place: another program never meets an
					// empty file here, which Git would take for a real object.
					if (!options?.create)
						throw domError('NotFoundError', `'${at}' does not exist`);
				} else if (found.kind === 'directory')
					throw domError('TypeMismatchError', `'${at}' is a directory`);
				return fileHandle(at, child);
			},
			async removeEntry(child, options) {
				checkName(child);
				const at = join(path, child);
				const found = await primitives.lstat(at);
				if (found === undefined)
					throw domError('NotFoundError', `'${at}' does not exist`);
				await literally(path, child, found);
				if (found.kind === 'directory' && !options?.recursive) {
					const inside = await primitives.readDir(at);
					if (inside.length > 0)
						throw domError('InvalidModificationError', `'${at}' is not empty`);
				}
				await primitives.remove(at, {
					recursive: found.kind === 'directory' && options?.recursive === true,
				});
			},
			async *values() {
				const entries = await primitives.readDir(path);
				for (const entry of [...entries].sort((a, b) =>
					a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
				)) {
					const at = join(path, entry.name);
					yield entry.kind === 'directory'
						? directoryAt(at, entry.name)
						: fileHandle(at, entry.name);
				}
			},
		};
	}

	const segments = root.split('/').filter(Boolean);
	return directoryAt(root, segments.at(-1) ?? '');
}
