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
 * and its first commit or remote creates its repository, as on
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
import type { OpenFolder, OpenFolderOptions } from './contract.js';
import type { Definition } from './definition.js';
import { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import { createStoredGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import type { Author } from './git/objects.js';
import { openAtRoot } from './open-at-root.js';
import { opening } from './opening.js';
import {
	createOpfsStorage,
	folderIn,
	type OpfsDirectoryHandle,
	type OpfsEnvironment,
	type OpfsFolder,
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
	if (!('move' in (scope.FileSystemFileHandle?.prototype ?? {})))
		return OpenFolderError.NoFileSystem({
			missing: 'FileSystemFileHandle.move',
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

/**
 * Open a folder in this browser's storage: for `app`, the app's own folder,
 * named after it, since a browser is handed no other; for `id`, the folder
 * named `id`. Refusals are returned, not thrown: a definition a folder
 * cannot keep, a page inside the desktop app, an ID that cannot name a
 * directory, missing browser storage, a table schema that cannot be used,
 * or tables that do not contain the definition.
 *
 * Opening writes nothing. A folder nobody wrote to lists no files, its
 * first write creates its directory, and its first commit or remote creates
 * its repository.
 */
export async function openAnyFolder<
	const TDefinition extends Definition = Definition,
>(
	options: OpenFolderOptions<TDefinition>,
): Promise<Result<Folder<TDefinition, Definition>, OpenFolderError>> {
	const { credentials, browser = {} } = options;
	const id = options.app === undefined ? options.id : options.app;
	const { data: target, error: definitionError } = opening(
		id,
		options.app,
		options.definition,
	);
	if (definitionError !== null) return Err(definitionError);
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
	let folder: OpfsFolder;
	try {
		folder = folderIn(await environment.getDirectory(), at.directory);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	return openAtRoot<TDefinition>(target, {
		detector: browserChangeDetector(environment, at.hintChannel),
		location: { kind: 'opfs', directory: at.directory },
		async start({ relay, landed }) {
			const boundary = createOpfsStorage({
				folder,
				locks,
				filesLock: at.filesLock,
				relay,
			});
			const backend = await createStoredGitBackend({
				folder,
				locks,
				lockName: at.gitLock,
				createLock: at.openLock,
				branch: 'main',
				httpFetch,
				credentials,
			});
			return {
				boundary,
				history: (prepared, appLocal) =>
					createHistory({
						backend,
						boundary,
						author,
						definition: prepared,
						appLocal,
						landed,
					}),
			};
		},
	});
}

/** The opener, every form typed (`OpenFolder`). */
export const openFolder: OpenFolder = openAnyFolder;
