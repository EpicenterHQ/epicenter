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
 * Opening writes nothing. The folder's first write creates its directory,
 * and its first commit, staging, or remote creates its repository, as on
 * every host; reads never write. A folder nobody wrote to lists no files
 * and has no history. Its remote is `remote.origin.url` in its Git configuration, which
 * `folder.sync.connect` sets. IndexedDB is never required, read, or written.
 *
 * `browser.ts` is the public entry; the automatic entry loads this module
 * directly, so choosing an adapter at run time never drags the other
 * adapter's code along through shared re-exports. Importing this module opens
 * nothing.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Buffer } from 'buffer/';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { browserChangeDetector } from './changes-browser.js';
import type {
	OpenDataFolder,
	OpenDataFolderOptions,
	OpenFolder,
} from './contract.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createHistory, type History } from './git/history.js';
import type { Author } from './git/objects.js';
import { createOpfsGitStore } from './git/opfs-git.js';
import { type FolderSchema, openAtRoot } from './open-at-root.js';
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
		window?: EventTarget;
		document?: EventTarget;
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
		page: { window: scope.window, document: scope.document },
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

/** One folder's directory and every name derived from its ID. */
type FolderAddress = {
	readonly directory: string;
	/** Held while deciding whether the directory is the folder, and by a download throughout. */
	readonly openLock: string;
	readonly filesLock: string;
	readonly gitLock: string;
	/** The `BroadcastChannel` pages of this origin tell each other their writes on. */
	readonly hintChannel: string;
};

/** The directory, Web Locks, and change channel of the folder named `id`. */
function folderAddress(id: string): FolderAddress {
	return {
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
 * an entry in it creates it.
 */
function lazyDirectory(
	origin: OpfsDirectoryHandle,
	name: string,
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
	...options
}) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	return openBrowserFolder<typeof definition>(prepared, options);
};

/**
 * Open the browser folder named `id` with its own `epicenter.json`, which the
 * handle never writes; a folder without one has no tables and no settings.
 * Opening writes nothing, as `openFolder`'s does: a folder nobody wrote to
 * lists no files, its first write creates its directory, and its first
 * commit, staging, or remote creates its repository.
 * An `epicenter.json` that cannot be used is `InvalidDeclaration`, and one
 * that does not contain the `lens` is `ShapeMismatch`.
 */
export const openDataFolder: OpenDataFolder = async <
	const TLens extends FolderDefinition = FolderDefinition,
>({
	lens,
	...options
}: OpenDataFolderOptions<TLens>) => {
	let shape: FolderDefinition | undefined;
	if (lens !== undefined) {
		const { data: prepared, error: lensError } = prepareFolderDefinition(lens);
		if (lensError !== null) return OpenFolderError.InvalidDefinition(lensError);
		shape = prepared;
	}
	return openBrowserFolder<TLens, FolderDefinition>('declared', options, shape);
};

async function openBrowserFolder<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
>(
	schema: FolderSchema,
	{ id, credentials, browser = {} }: OpenDataFolderOptions,
	lens?: FolderDefinition,
): Promise<
	Result<Folder<TDefinition, TDeclared>, OpenFolderError>
> {
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
	// isomorphic-git reads a global `Buffer` at call time, and browsers have
	// none; install the `buffer` package's before the first Git call.
	const scope = globalThis as { Buffer?: unknown };
	if (scope.Buffer === undefined) scope.Buffer = Buffer;
	const at = folderAddress(id);
	const { locks } = environment;
	// The first write makes the directory, so no read ever writes.
	let root: OpfsDirectoryHandle;
	try {
		root = lazyDirectory(await environment.getDirectory(), at.directory);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return openAtRoot<TDefinition, TDeclared, History>(schema, {
		lens,
		detector: browserChangeDetector(environment, at.hintChannel),
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
				store: createOpfsGitStore({ root }),
				locks,
				lockName: at.gitLock,
				createLock: at.openLock,
				branch: 'main',
				httpFetch,
				credentials,
			});
			return {
				boundary,
				history: (prepared) =>
					createHistory({
						backend,
						boundary,
						author,
						definition: prepared,
						landed,
					}),
			};
		},
	});
}
