/**
 * Test helper: the browser storage browser suites run on, which is what a
 * browser opens: the origin private file system, here the in-memory
 * stand-in (`opfs.test-support.ts`).
 *
 * `createTestStorage()` owns one fresh stand-in tree. Suites open browser
 * folders with `browserStorage(storage)` or build raw storage with
 * `rawBrowserFolder`. A suite that reopens with the same storage reopens the
 * same folder, and a raw folder built for an ID is the folder the opener
 * opens for that ID. Where the shared `navigator.locks` stand-in is not
 * installed, a private one is used: browser folders require Web Locks.
 *
 * Application tests import this file by its path. `testBrowserStorage()`
 * gives them fresh storage in one call.
 */
import { createHash } from 'node:crypto';
import type { LockingStorage } from './boundary.js';
import type { BrowserFolderOptions } from './contract.js';
import type { FolderLocation } from './folder.js';
import type { GitBackend, GitRemote } from './git/backend.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { type MemoryOpfs, memoryOpfs } from './opfs.test-support.js';
import {
	createOpfsStorage,
	ensureDirectory,
	type OpfsLocks,
	presentFolder,
} from './opfs-store.js';
import { createWebLocks } from './web-locks.test-support.js';

/** A test's stand-in tree, and optionally the channel its handles relay hints on. */
export type TestStorage = {
	readonly opfs: MemoryOpfs;
	readonly BroadcastChannel?: typeof BroadcastChannel;
};

/** Fresh, empty storage. */
export function createTestStorage(
	options: { BroadcastChannel?: typeof BroadcastChannel } = {},
): TestStorage {
	return { opfs: memoryOpfs(), BroadcastChannel: options.BroadcastChannel };
}

const fallback = createWebLocks() as unknown as OpfsLocks;

/** `navigator.locks` when a test installed it, otherwise a private stand-in. */
export const testLocks: OpfsLocks = {
	request: (name, options, work) =>
		(
			(globalThis.navigator as unknown as { locks?: OpfsLocks } | undefined)
				?.locks ?? fallback
		).request(name, options, work),
};

/** The stand-in tree behind `storage`. */
export function opfsOf(storage: TestStorage): MemoryOpfs {
	return storage.opfs;
}

/** `browser` options that open the stand-in tree behind `storage`. */
export function browserStorage(
	storage: TestStorage,
): Pick<BrowserFolderOptions, 'opfs'> {
	return {
		opfs: {
			getDirectory: () => storage.opfs.getDirectory(),
			locks: testLocks,
			BroadcastChannel: storage.BroadcastChannel,
		},
	};
}

/** `browser` options for fresh, empty storage. */
export function testBrowserStorage(
	options: { BroadcastChannel?: typeof BroadcastChannel } = {},
): Pick<BrowserFolderOptions, 'opfs'> {
	return browserStorage(createTestStorage(options));
}

/** Where the opener keeps folder `id`. */
export function locationOf(id: string): FolderLocation {
	return { kind: 'opfs', directory: id };
}

export type RawBrowserFolder = {
	readonly boundary: LockingStorage;
	/** A Git backend on the same storage, with the locks the opener uses. */
	/** With `remote`, its URL is set in Git configuration first. */
	backend(options?: {
		branch?: string;
		remote?: GitRemote;
	}): Promise<GitBackend>;
	/**
	 * Every stored entry except Git objects, by kind and path, with values
	 * hashed: what an operation that wrote nothing must leave equal.
	 */
	dump(): Promise<Record<string, string>>;
	readonly opfs: MemoryOpfs;
};

const digest = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

const skipObjects = (key: string) => key.startsWith('/git/objects/');

/**
 * Every stored entry of folder `id`, values hashed, creating
 * nothing. `contents:` and `directories:` take folder paths, `git:` takes
 * `/git/...` paths. `skip` leaves out keys an operation may change without
 * writing the folder: by default Git objects.
 */
export async function dumpStorage(
	storage: TestStorage,
	id: string,
	skip: (key: string) => boolean = skipObjects,
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	const tree = storage.opfs;
	const directory = id;
	for (const [path, bytes] of tree.files(directory)) {
		const [kind, key] = path.startsWith('.git/')
			? ['git', `/git/${path.slice(5)}`]
			: ['contents', path];
		if (skip(key)) continue;
		result[`${kind}:${key}`] = digest(bytes);
	}
	for (const path of tree.directories(directory))
		if (path !== '.git' && !path.startsWith('.git/'))
			result[`directories:${path}`] = '';
	return result;
}

/**
 * Raw storage for folder `id`: the folder the opener opens for that ID with
 * the same storage. The directory is created; nothing else is.
 */
export async function rawBrowserFolder({
	id,
	storage = createTestStorage(),
}: {
	id: string;
	storage?: TestStorage;
}): Promise<RawBrowserFolder> {
	const tree = storage.opfs;
	const { data: root, error: directoryError } = await ensureDirectory(
		await tree.getDirectory(),
		id,
	);
	if (directoryError !== null) throw new Error(directoryError.message);
	const filesLock = `epicenter-folder:${id}:files`;
	return {
		boundary: createOpfsStorage({
			folder: presentFolder(root),
			locks: testLocks,
			filesLock,
			landed: () => {},
		}),
		backend: async ({ branch = 'main', remote } = {}) => {
			const backend = await createStoredGitBackend({
				store: createOpfsGitStore({ folder: presentFolder(root) }),
				locks: testLocks,
				lockName: `epicenter-folder:${id}:git`,
				branch,
			});
			if (remote !== undefined) await backend.setRemote(remote.url);
			return backend;
		},
		dump: () => dumpStorage(storage, id),
		opfs: tree,
	};
}

/**
 * Set folder `id`'s remote in its Git configuration, as `sync.connect` leaves
 * it, without transferring anything: the folder opens with that remote.
 */
export async function configureRemote(
	storage: TestStorage,
	id: string,
	url: string,
): Promise<void> {
	const raw = await rawBrowserFolder({ id, storage });
	await raw.backend({ remote: { url, branch: 'main' } });
}
