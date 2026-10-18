/**
 * Test helper: an in-memory origin private file system.
 *
 * It models the parts of OPFS a folder relies on, as Chromium documents them:
 * handles name a path, a writable stream publishes its bytes only when it
 * closes, a `File` from `getFile` refuses to read once its file changed, and
 * names of the wrong kind raise `TypeMismatchError`. `faults` interrupts a
 * close or a removal at a chosen path. Passing here does not show that a
 * browser behaves this way; `evidence/opfs` runs the same checks in one.
 *
 * Two behaviors come from Chromium's source and were observed by probes in
 * Chrome 142, not from its documentation; no other engine was checked.
 *
 * - An open writable stream holds a lock on its file. `removeEntry` of that
 *   file, or a recursive `removeEntry` of a directory above it, fails with
 *   `NoModificationAllowedError` before removing anything: the file and its
 *   siblings stay. Once the stream closes, all its bytes are published.
 * - A stream opened without `keepExistingData` for a file removed after its
 *   handle was taken still opens, while `getFile` on that handle is
 *   `NotFoundError`. Writing and closing that stream succeeds and creates the
 *   file again at the path; aborting it leaves the path absent.
 *
 * Here a close also fails when the file's directory is gone too; the probes
 * did not cover that. `drop` acts below the API and takes no lock.
 */

import { SCRATCH_DIRECTORY } from './boundary.js';
import type {
	OpfsDirectoryHandle,
	OpfsEnvironment,
	OpfsFile,
	OpfsFileHandle,
	OpfsFolder,
	OpfsLocks,
	OpfsWritable,
} from './opfs-store.js';
import { basename } from './paths.js';

/** A folder whose directory is `handle`, already there. */
export const presentFolder = (handle: OpfsDirectoryHandle): OpfsFolder => ({
	existing: async () => handle,
	made: async () => handle,
});

/**
 * OPFS handles over `directory` that call `beforePublish` with a file's
 * handle just before its new bytes publish: the window in which a save is
 * running, which a test can hold open. An existing file publishes when its
 * stream closes. A new file publishes when its staged copy moves into place,
 * and is reported under the name it moves to; its staged stream is not.
 */
export function holdCloses(
	directory: OpfsDirectoryHandle,
	beforePublish: (file: OpfsFileHandle) => Promise<void>,
): OpfsDirectoryHandle {
	const staging = directory.name === basename(SCRATCH_DIRECTORY);
	const holdFile = (file: OpfsFileHandle): OpfsFileHandle => ({
		kind: 'file',
		name: file.name,
		getFile: () => file.getFile(),
		async move(destination, name) {
			await beforePublish({ ...holdFile(file), name });
			return file.move(heldOver.get(destination) ?? destination, name);
		},
		async createWritable(options) {
			const writable = await file.createWritable(options);
			return {
				write: (data) => writable.write(data),
				abort: (reason) => writable.abort(reason),
				async close() {
					if (!staging) await beforePublish(file);
					return writable.close();
				},
			};
		},
	});
	const held: OpfsDirectoryHandle = {
		kind: 'directory',
		name: directory.name,
		getDirectoryHandle: async (name, options) =>
			holdCloses(
				await directory.getDirectoryHandle(name, options),
				beforePublish,
			),
		getFileHandle: async (name, options) =>
			holdFile(await directory.getFileHandle(name, options)),
		removeEntry: (name, options) => directory.removeEntry(name, options),
		async *values() {
			for await (const entry of directory.values())
				yield entry.kind === 'file'
					? holdFile(entry)
					: holdCloses(entry, beforePublish);
		},
	};
	heldOver.set(held, directory);
	return held;
}

/** The directory each `holdCloses` handle wraps, which a move is given. */
const heldOver = new WeakMap<OpfsDirectoryHandle, OpfsDirectoryHandle>();

type FileNode = {
	kind: 'file';
	bytes: Uint8Array;
	version: number;
	lastModified: number;
};
type DirectoryNode = { kind: 'directory'; children: Map<string, Node> };
type Node = FileNode | DirectoryNode;

/** What an interrupted close does instead of publishing normally. */
export type CloseFault =
	/** Throw before publishing: the old bytes stay. */
	| 'fail'
	/** Publish, then throw: the caller cannot tell from the call. */
	| 'lost'
	/** Publish these bytes instead, then throw: a third writer won. */
	| { readonly publish: Uint8Array };

export type Faults = {
	/** Asked before every write to a stream; `'fail'` throws before anything is published. */
	write?: (path: string) => 'fail' | undefined;
	/** Asked before every close, with the file's path from the origin root. */
	close?: (path: string) => CloseFault | undefined;
	/** Asked before every removal; `'fail'` refuses it. */
	remove?: (path: string) => 'fail' | undefined;
	/** Runs when a stream is asked for, before it opens. */
	open?: (path: string) => Promise<void> | void;
	/** Asked before every move, with the destination's path; `'fail'` refuses it. */
	move?: (path: string) => 'fail' | undefined;
};

const fail = (name: string, message: string) => new DOMException(message, name);

/** Where a directory handle of the stand-in points, which a move reads. */
const AT = Symbol('path');

function checkName(name: string) {
	if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name))
		throw new TypeError(`Name is not allowed: ${name}`);
}

export type MemoryOpfs = {
	readonly faults: Faults;
	getDirectory(): Promise<OpfsDirectoryHandle>;
	/** Every file below `prefix`, by path relative to it, `.git` included. */
	files(prefix?: string): Map<string, Uint8Array>;
	/** Every directory below `prefix`, relative to it. */
	directories(prefix?: string): string[];
	/** Write bytes as an uncooperative writer would: no lock, no checks. */
	put(path: string, bytes: Uint8Array): void;
	/** Remove a file or directory as an uncooperative writer would. */
	drop(path: string): void;
};

export function memoryOpfs(): MemoryOpfs {
	const root: DirectoryNode = { kind: 'directory', children: new Map() };
	const faults: Faults = {};
	let clock = 0;
	/** Open writable streams, by file path. */
	const streams = new Map<string, number>();

	function resolve(path: readonly string[]): Node | undefined {
		let node: Node = root;
		for (const segment of path) {
			if (node.kind !== 'directory') return undefined;
			const next: Node | undefined = node.children.get(segment);
			if (next === undefined) return undefined;
			node = next;
		}
		return node;
	}

	function directoryAt(path: readonly string[]): DirectoryNode {
		const node = resolve(path);
		if (node === undefined)
			throw fail('NotFoundError', `${path.join('/')} was not found`);
		if (node.kind !== 'directory')
			throw fail('TypeMismatchError', `${path.join('/')} is not a directory`);
		return node;
	}

	function fileAt(path: readonly string[]): FileNode {
		const node = resolve(path);
		if (node === undefined)
			throw fail('NotFoundError', `${path.join('/')} was not found`);
		if (node.kind !== 'file')
			throw fail('TypeMismatchError', `${path.join('/')} is not a file`);
		return node;
	}

	function fileHandle(path: readonly string[]): OpfsFileHandle {
		return {
			kind: 'file',
			name: path.at(-1)!,
			async move(destination, name) {
				checkName(name);
				const node = fileAt(path);
				const to = (destination as { [AT]?: readonly string[] })[AT];
				if (to === undefined)
					throw fail('NotFoundError', 'The destination is not of this origin');
				const target = [...to, name];
				if (faults.move?.(target.join('/')) === 'fail')
					throw fail('InvalidStateError', 'Injected move failure');
				const into = directoryAt(to);
				if (into.children.get(name)?.kind === 'directory')
					throw fail('TypeMismatchError', `${name} is a directory`);
				directoryAt(path.slice(0, -1)).children.delete(path.at(-1)!);
				into.children.set(name, {
					...node,
					version: node.version + 1,
					lastModified: Math.max(Date.now(), ++clock),
				});
			},
			async getFile(): Promise<OpfsFile & { lastModified: number }> {
				const node = fileAt(path);
				const { version, bytes, lastModified } = node;
				return {
					size: bytes.byteLength,
					lastModified,
					async arrayBuffer() {
						const now = resolve(path);
						if (now !== node || node.version !== version)
							throw fail(
								'NotReadableError',
								'The file changed after this snapshot was taken',
							);
						return bytes.slice().buffer as ArrayBuffer;
					},
				};
			},
			async createWritable(options) {
				const key = path.join('/');
				await faults.open?.(key);
				// A stream without the old bytes opens even where the file went.
				const node =
					resolve(path) === undefined && !options?.keepExistingData
						? undefined
						: fileAt(path);
				let buffer =
					node !== undefined && options?.keepExistingData
						? node.bytes.slice()
						: new Uint8Array();
				let done = false;
				streams.set(key, (streams.get(key) ?? 0) + 1);
				const release = () => {
					const open = (streams.get(key) ?? 1) - 1;
					if (open === 0) streams.delete(key);
					else streams.set(key, open);
				};
				const publish = (bytes: Uint8Array) => {
					// Moving the stream's file into place creates it again if it went.
					if (resolve(path) === undefined)
						directoryAt(path.slice(0, -1)).children.set(path.at(-1)!, {
							kind: 'file',
							bytes: new Uint8Array(),
							version: 0,
							lastModified: 0,
						});
					const target = fileAt(path);
					target.bytes = bytes;
					target.version++;
					target.lastModified = Math.max(Date.now(), ++clock);
				};
				const writable: OpfsWritable = {
					async write(data) {
						if (done) throw new TypeError('The stream is closed');
						if (faults.write?.(key) === 'fail')
							throw fail('QuotaExceededError', 'Injected write failure');
						const next = new Uint8Array(buffer.byteLength + data.byteLength);
						next.set(buffer);
						next.set(data, buffer.byteLength);
						buffer = next;
					},
					async close() {
						if (done) throw new TypeError('The stream is closed');
						done = true;
						release();
						const fault = faults.close?.(key);
						if (fault === 'fail')
							throw fail('InvalidStateError', 'Injected close failure');
						if (fault === 'lost') {
							publish(buffer);
							throw fail('AbortError', 'Injected lost close reply');
						}
						if (fault !== undefined) {
							publish(fault.publish.slice());
							throw fail('AbortError', 'Injected close with other bytes');
						}
						publish(buffer);
					},
					async abort() {
						if (!done) release();
						done = true;
					},
				};
				return writable;
			},
		};
	}

	function directoryHandle(path: readonly string[]): OpfsDirectoryHandle {
		return Object.assign(directoryHandleAt(path), { [AT]: path });
	}

	function directoryHandleAt(path: readonly string[]): OpfsDirectoryHandle {
		return {
			kind: 'directory',
			name: path.at(-1) ?? '',
			async getDirectoryHandle(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing?.kind === 'file')
					throw fail('TypeMismatchError', `${name} is a file`);
				if (existing === undefined) {
					if (!options?.create)
						throw fail('NotFoundError', `${name} was not found`);
					directory.children.set(name, {
						kind: 'directory',
						children: new Map(),
					});
				}
				return directoryHandle([...path, name]);
			},
			async getFileHandle(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing?.kind === 'directory')
					throw fail('TypeMismatchError', `${name} is a directory`);
				if (existing === undefined) {
					if (!options?.create)
						throw fail('NotFoundError', `${name} was not found`);
					directory.children.set(name, {
						kind: 'file',
						bytes: new Uint8Array(),
						version: 0,
						lastModified: Math.max(Date.now(), ++clock),
					});
				}
				return fileHandle([...path, name]);
			},
			async removeEntry(name, options) {
				checkName(name);
				const directory = directoryAt(path);
				const existing = directory.children.get(name);
				if (existing === undefined)
					throw fail('NotFoundError', `${name} was not found`);
				if (faults.remove?.([...path, name].join('/')) === 'fail')
					throw fail('InvalidStateError', 'Injected removal failure');
				// The entry, or for a directory anything below it, has a stream open.
				const removed = [...path, name].join('/');
				const locked = [...streams.keys()].some(
					(open) => open === removed || open.startsWith(`${removed}/`),
				);
				if (locked)
					throw fail(
						'NoModificationAllowedError',
						`${name} is locked by an open writable stream`,
					);
				if (
					existing.kind === 'directory' &&
					existing.children.size > 0 &&
					!options?.recursive
				)
					throw fail('InvalidModificationError', `${name} is not empty`);
				directory.children.delete(name);
			},
			async *values() {
				const directory = directoryAt(path);
				for (const [name, node] of [...directory.children]) {
					if (directory.children.get(name) !== node) continue;
					yield node.kind === 'file'
						? fileHandle([...path, name])
						: directoryHandle([...path, name]);
				}
			},
		};
	}

	const split = (path: string) => path.split('/').filter((part) => part !== '');

	function list(prefix: string) {
		const files = new Map<string, Uint8Array>();
		const directories: string[] = [];
		const start = resolve(split(prefix));
		function visit(node: Node, at: string) {
			if (node.kind === 'file') {
				files.set(at, node.bytes.slice());
				return;
			}
			if (at !== '') directories.push(at);
			for (const [name, child] of node.children)
				visit(child, at === '' ? name : `${at}/${name}`);
		}
		if (start !== undefined) visit(start, '');
		return { files, directories: directories.sort() };
	}

	return {
		faults,
		getDirectory: async () => directoryHandle([]),
		files: (prefix = '') => list(prefix).files,
		directories: (prefix = '') => list(prefix).directories,
		put(path, bytes) {
			const parts = split(path);
			let directory = root;
			for (const part of parts.slice(0, -1)) {
				let next = directory.children.get(part);
				if (next === undefined) {
					next = { kind: 'directory', children: new Map() };
					directory.children.set(part, next);
				}
				if (next.kind !== 'directory') throw new Error(`${part} is a file`);
				directory = next;
			}
			const name = parts.at(-1)!;
			const existing = directory.children.get(name);
			if (existing?.kind === 'file') {
				existing.bytes = bytes.slice();
				existing.version++;
			} else
				directory.children.set(name, {
					kind: 'file',
					bytes: bytes.slice(),
					version: 0,
					lastModified: Math.max(Date.now(), ++clock),
				});
		},
		drop(path) {
			const parts = split(path);
			const parent = resolve(parts.slice(0, -1));
			if (parent?.kind === 'directory') parent.children.delete(parts.at(-1)!);
		},
	};
}

/**
 * An environment over `opfs` whose locks are whatever `navigator.locks` is
 * when a lock is asked for. Use with `useWebLocks()`.
 */
export function opfsEnvironment(
	opfs: MemoryOpfs,
	options: { BroadcastChannel?: typeof BroadcastChannel } = {},
): OpfsEnvironment {
	const locks: OpfsLocks = {
		request: (name, requestOptions, work) =>
			(globalThis.navigator as unknown as { locks: OpfsLocks }).locks.request(
				name,
				requestOptions,
				work,
			),
	};
	return {
		getDirectory: () => opfs.getDirectory(),
		locks,
		BroadcastChannel: options.BroadcastChannel,
	};
}
