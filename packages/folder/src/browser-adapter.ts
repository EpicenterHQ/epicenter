/**
 * The browser adapter: a folder in this browser's origin private file system.
 *
 * A folder is the directory named by its ID at the root of the origin's
 * private file system: every literal path is one stored file, every directory
 * (empty ones too) is a stored directory, and `.git` inside it is the
 * folder's private Git state. A reload reopens the same files and history.
 * Inside the desktop app it refuses, because that page's folder is a
 * directory the shell owns.
 *
 * Opening writes nothing. The folder's first write creates its directory
 * and its repository together; reads never write. A folder nobody wrote to
 * lists no files and has no history. Its remote is `remote.origin.url` in its Git configuration, which
 * `folder.sync.connect` sets. IndexedDB is never required, read, or written.
 *
 * `browser.ts` is the public entry; the automatic entry loads this module
 * directly, so choosing an adapter at run time never drags the other
 * adapter's code along through shared re-exports. Importing this module opens
 * nothing.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ensureBufferGlobal } from './buffer-global.js';
import type { OpenFolder } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import { OpenFolderError } from './errors.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import type { Author } from './git/objects.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { type FolderAddress, openAtRoot } from './open-at-root.js';
import {
	createOpfsFileBoundary,
	errorName,
	type OpfsDirectoryHandle,
	type OpfsEnvironment,
	type OpfsLocks,
} from './opfs-store.js';

/** Who records history when the caller names nobody. */
const LOCAL_AUTHOR: Author = { name: 'Local', email: 'local@localhost' };

/** The browser's own storage, or the refusal naming what is missing. */
function globalEnvironment(): Result<
	OpfsEnvironment,
	Extract<OpenFolderError, { name: 'NoFileSystem' }>
> {
	const scope = globalThis as {
		navigator?: Navigator;
		FileSystemFileHandle?: { prototype: object };
		BroadcastChannel?: typeof BroadcastChannel;
	};
	const storage = scope.navigator?.storage;
	if (typeof storage?.getDirectory !== 'function')
		return OpenFolderError.NoFileSystem({
			missing: 'navigator.storage.getDirectory',
		});
	if (!('createWritable' in (scope.FileSystemFileHandle?.prototype ?? {})))
		return OpenFolderError.NoFileSystem({
			missing: 'FileSystemFileHandle.createWritable',
		});
	const locks = scope.navigator?.locks;
	if (locks === undefined)
		return OpenFolderError.NoFileSystem({ missing: 'navigator.locks' });
	return Ok({
		getDirectory: () =>
			storage.getDirectory() as unknown as Promise<OpfsDirectoryHandle>,
		locks: locks as unknown as OpfsLocks,
		BroadcastChannel: scope.BroadcastChannel,
	});
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const UNNAMEABLE = /[/\\\u0000-\u001f\u007f]/;

/** Whether `id` can name a directory as it is, with nothing escaped. */
const isFolderName = (id: unknown): id is string =>
	typeof id === 'string' &&
	id.trim() !== '' &&
	id !== '.' &&
	id !== '..' &&
	!UNNAMEABLE.test(id);

/** The directory, Web Locks, and hint channel of the folder named `id`. */
function folderAddress(id: string): FolderAddress {
	return {
		address: id,
		directory: id,
		openLock: `epicenter-folder:${id}:open`,
		filesLock: `epicenter-folder:${id}:files`,
		gitLock: `epicenter-folder:${id}:git`,
		hintChannel: `epicenter-folder:${id}:hints`,
	};
}

const notFound = (name: string) =>
	Object.assign(new Error(`'${name}' does not exist`), {
		name: 'NotFoundError',
	});

/**
 * The directory `name` in `origin`, which may not exist yet. Reading a missing
 * directory finds nothing and lists nothing; the first call that creates
 * an entry in it creates it, then awaits `whenMade` before creating that entry.
 */
function lazyDirectory(
	origin: OpfsDirectoryHandle,
	name: string,
	whenMade: () => Promise<void>,
): OpfsDirectoryHandle {
	let made: OpfsDirectoryHandle | undefined;
	let making: Promise<OpfsDirectoryHandle> | undefined;
	/** The directory if it exists, without creating it. */
	async function existing(): Promise<OpfsDirectoryHandle | undefined> {
		if (made !== undefined) return made;
		try {
			made = await origin.getDirectoryHandle(name);
			return made;
		} catch (cause) {
			if (errorName(cause) === 'NotFoundError') return undefined;
			throw cause;
		}
	}
	async function resolve(create: boolean | undefined) {
		if (create) {
			if (made !== undefined) return made;
			making ??= (async () => {
				const directory = await origin.getDirectoryHandle(name, {
					create: true,
				});
				made = directory;
				await whenMade();
				return directory;
			})().finally(() => {
				making = undefined;
			});
			return making;
		}
		const found = await existing();
		if (found === undefined) throw notFound(name);
		return found;
	}
	return {
		kind: 'directory',
		name,
		getDirectoryHandle: async (entry, options) =>
			(await resolve(options?.create)).getDirectoryHandle(entry, options),
		getFileHandle: async (entry, options) =>
			(await resolve(options?.create)).getFileHandle(entry, options),
		removeEntry: async (entry, options) =>
			(await resolve(false)).removeEntry(entry, options),
		async *values() {
			const found = await existing();
			if (found !== undefined) yield* found.values();
		},
	};
}

/**
 * Open the browser folder named `id`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a page inside the desktop app, an ID that
 * cannot name a directory, or missing browser storage. Nothing is written.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id,
	credentials,
	browser = {},
}) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (!isFolderName(id)) return OpenFolderError.InvalidId({ id: String(id) });
	const author = browser.author ?? LOCAL_AUTHOR;
	const { httpFetch } = browser;
	let environment = browser.opfs;
	if (environment === undefined) {
		const { data: found, error: environmentError } = globalEnvironment();
		if (environmentError !== null) return Err(environmentError);
		environment = found;
	}
	ensureBufferGlobal();
	const at = folderAddress(id);
	const { locks } = environment;
	// The folder's repository comes with its directory: the first write
	// makes both, so no read ever writes.
	let ensureRepository = async () => {};
	let root: OpfsDirectoryHandle;
	try {
		root = lazyDirectory(await environment.getDirectory(), at.directory, () =>
			ensureRepository(),
		);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return openAtRoot<typeof definition>(prepared, environment, {
		at,
		location: { kind: 'opfs', directory: at.directory },
		// An incoming update a closed tab left half published stays pending:
		// opening reads it into the snapshot and never resumes it.
		async start({ relay, landed }) {
			const boundary = createOpfsFileBoundary({
				root,
				locks,
				filesLock: at.filesLock,
				landed: relay,
			});
			const backend = await createStoredGitBackend({
				store: createOpfsGitStore({
					root,
					locks,
					filesLock: at.filesLock,
					branch: 'main',
					landed: relay,
				}),
				locks,
				lockName: at.gitLock,
				createLock: at.openLock,
				branch: 'main',
				httpFetch,
				credentials,
			});
			ensureRepository = backend.ensureRepository;
			const history = createHistory({
				backend,
				boundary,
				author,
				definition: prepared,
				landed,
			});
			return { boundary, history };
		},
	});
};
