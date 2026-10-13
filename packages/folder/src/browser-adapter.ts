/**
 * The browser adapter: a folder in this browser's origin private file system.
 *
 * Each folder is one directory: every literal path is one stored file, every
 * directory (empty ones too) is a stored directory, and `.git` inside it is
 * the folder's private Git state. A reload reopens the same files and
 * history. This is the browser implementation and nothing else: inside the
 * desktop app it refuses, because that page's folder is a directory the
 * shell owns.
 *
 * The captured address (channel, owner, folder ID) names the directory, the
 * Web Locks, and the hint channel. The directory is the folder only while its
 * ready marker names that address (`claimDirectory`). The ready marker also
 * records the remote the folder was made with, and a ready folder opens only
 * with that remote. IndexedDB is never required, read, or written.
 *
 * `downloadFolder` makes a folder from a remote's history before
 * anything opens it. Its marker records the pending download first and
 * becomes the ready marker last, so a download that stops leaves a directory
 * the opener refuses and only the same download continues.
 *
 * `inspectFolder` reads the same decision without writing.
 *
 * This module exports the opener, the inspection, and the download. `browser.ts` is the
 * public entry; the automatic entry loads this module directly, so choosing
 * an adapter at run time never drags the other adapter's code along through
 * shared re-exports.
 *
 * Importing this module opens nothing.
 */

import type { AccountIdentity } from '@epicenter/principal';
import { accountKey } from '@epicenter/principal/account-key';
import { isTauri } from '@tauri-apps/api/core';
import * as git from 'isomorphic-git';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { ensureBufferGlobal } from './buffer-global.js';
import type { BrowserFolderOptions, OpenFolder } from './contract.js';
import {
	type FolderDefinition,
	prepareFolderDefinition,
} from './definition.js';
import { DownloadFolderError, OpenFolderError } from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type Folder,
	type FolderLocation,
} from './folder.js';
import type { GitRemote } from './git/backend.js';
import { createStoredGitBackend, GITDIR } from './git/browser-backend.js';
import { createHistory } from './git/history.js';
import type { HttpFetch } from './git/http.js';
import type { Author } from './git/objects.js';
import { createOpfsGitSession, createOpfsGitStore } from './git/opfs-git.js';
import { callObserver } from './observer.js';
import {
	createOpfsFileBoundary,
	ensureDirectory,
	holding,
	lookup,
	type OpfsDirectoryHandle,
	type OpfsEnvironment,
	type OpfsLocks,
	PRIVATE_DIRECTORY,
	READY_MARKER,
	readHandle,
	writePrivateFile,
} from './opfs-store.js';
import { publishDefinition } from './publish-definition.js';
import { withPublication } from './storage.js';

/** Who records history that never leaves this browser. */
const LOCAL_AUTHOR: Author = { name: 'Local', email: 'local@localhost' };

/** Refusals of a browser call made before it acquires anything. */
type AddressError = Extract<
	OpenFolderError,
	{ name: 'InvalidId' | 'InvalidBrowserScope' | 'NoFileSystem' | 'InsideTauri' }
>;

/** The browser's own storage, or the refusal naming what is missing. */
function globalEnvironment(): Result<OpfsEnvironment, AddressError> {
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this escapes.
const UNNAMEABLE = /[%/\\\u0000-\u001f\u007f]/g;

/**
 * One directory name for a folder ID or account key. Only what a directory
 * name cannot hold is escaped, and `%` with it, so distinct values stay
 * distinct names.
 */
function entryName(value: string): string {
	if (value === '.') return '%2E';
	if (value === '..') return '%2E%2E';
	return value.replace(
		UNNAMEABLE,
		(character) =>
			`%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
	);
}

/** One folder's captured address and every name derived from it. */
type FolderAddress = {
	readonly address: string;
	readonly directory: string;
	/** Held while deciding whether the directory is the folder, and by a download throughout. */
	readonly openLock: string;
	readonly filesLock: string;
	readonly gitLock: string;
	readonly hintChannel: string;
};

function folderAddress(
	channel: 'release' | 'development',
	owner: string | null,
	id: string,
): FolderAddress {
	const address = JSON.stringify([
		channel,
		owner === null ? 'local' : 'accounts',
		owner,
		id,
	]);
	return {
		address,
		directory: [
			channel === 'release' ? 'Epicenter' : 'Epicenter Dev',
			...(owner === null ? ['local'] : ['accounts', entryName(owner)]),
			entryName(id),
		].join('/'),
		openLock: `epicenter-folder-opfs-open:${address}`,
		filesLock: `epicenter-folder-opfs-files:${address}`,
		gitLock: `epicenter-folder-opfs-git:${address}`,
		hintChannel: `epicenter-folder-opfs-hints:${address}`,
	};
}

/**
 * The storage and address a browser call works on, or the refusal naming
 * why there is none. The scope is read before the first await, so changing
 * login or mutating options afterward cannot retarget the call.
 */
async function captureAddress(
	id: string,
	scope: BrowserFolderOptions['scope'],
	opfs: OpfsEnvironment | undefined,
): Promise<
	Result<
		{ readonly environment: OpfsEnvironment; readonly at: FolderAddress },
		AddressError
	>
> {
	let environment = opfs;
	if (environment === undefined) {
		const { data: found, error: environmentError } = globalEnvironment();
		if (environmentError !== null) return Err(environmentError);
		environment = found;
	}
	ensureBufferGlobal();
	const channel = scope?.channel ?? 'release';
	if (
		scope !== undefined &&
		scope?.channel !== 'release' &&
		scope?.channel !== 'development'
	)
		return OpenFolderError.InvalidBrowserScope({ reason: 'unknown channel' });
	let owner: string | null = null;
	try {
		if (scope?.account !== undefined) owner = await accountKey(scope.account);
	} catch (cause) {
		return OpenFolderError.InvalidBrowserScope({
			reason:
				cause instanceof Error ? cause.message : 'invalid account identity',
		});
	}
	return Ok({ environment, at: folderAddress(channel, owner, id) });
}

const MARKER_PATH = `${PRIVATE_DIRECTORY}/${READY_MARKER}`;

/** A download that has begun at `address` and is not marked ready yet. */
type PendingDownload = {
	readonly address: string;
	readonly remote: GitRemote;
};

/**
 * What a ready marker says about the folder's remote: nothing (a folder made
 * without one, or by a version that kept the remote only in Git
 * configuration), a URL and branch, or a `remote` property that is not one.
 */
type RecordedRemote =
	| { readonly kind: 'unrecorded' }
	| { readonly kind: 'recorded'; readonly remote: GitRemote }
	| { readonly kind: 'malformed' };

/** A ready marker: the address whose folder this is, and its remote. */
type ReadyMarker = {
	readonly kind: 'ready';
	readonly address: string;
	readonly remote: RecordedRemote;
};

/**
 * What a marker with bytes records: the address whose folder this is, a
 * download in progress, or neither. A pending download has no top-level
 * `address`, so an opener that knows only ready markers refuses it too.
 */
type MarkerRecord =
	| ReadyMarker
	| { readonly kind: 'pending'; readonly download: PendingDownload }
	| { readonly kind: 'none' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;

function recordedRemote(value: unknown): RecordedRemote {
	if (value === undefined) return { kind: 'unrecorded' };
	if (
		isRecord(value) &&
		typeof value.url === 'string' &&
		typeof value.branch === 'string'
	)
		return {
			kind: 'recorded',
			remote: { url: value.url, branch: value.branch },
		};
	return { kind: 'malformed' };
}

function markerRecord(bytes: Uint8Array): MarkerRecord {
	let marker: unknown;
	try {
		marker = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		);
	} catch {
		// Not JSON text: it records nothing.
		return { kind: 'none' };
	}
	if (!isRecord(marker)) return { kind: 'none' };
	// Extra record properties do not affect directory identity.
	if (typeof marker.address === 'string')
		return {
			kind: 'ready',
			address: marker.address,
			remote: recordedRemote(marker.remote),
		};
	const download = marker.download;
	if (
		isRecord(download) &&
		typeof download.address === 'string' &&
		isRecord(download.remote) &&
		typeof download.remote.url === 'string' &&
		typeof download.remote.branch === 'string'
	)
		return {
			kind: 'pending',
			download: {
				address: download.address,
				remote: { url: download.remote.url, branch: download.remote.branch },
			},
		};
	return { kind: 'none' };
}

const describePending = ({ address, remote }: PendingDownload) =>
	`holds an unfinished download for ${address} of ${remote.url} (branch ${remote.branch})`;

/**
 * Write the marker. Throws when the write is not confirmed. A ready marker
 * records the remote the folder was made with, if it has one.
 */
function writeMarker(
	root: OpfsDirectoryHandle,
	record:
		| { address: string; remote?: GitRemote }
		| { download: PendingDownload },
) {
	return writePrivateFile(
		root,
		READY_MARKER,
		new TextEncoder().encode(JSON.stringify(record)),
	);
}

/**
 * The first entry of an unmarked folder directory that is not what an
 * interrupted first open leaves: `.git` holding at most an empty marker.
 */
async function occupant(
	directory: OpfsDirectoryHandle,
): Promise<string | undefined> {
	for await (const entry of directory.values()) {
		if (entry.name !== PRIVATE_DIRECTORY || entry.kind !== 'directory')
			return entry.name;
		for await (const inner of entry.values()) {
			const path = `${PRIVATE_DIRECTORY}/${inner.name}`;
			if (inner.kind !== 'file' || inner.name !== READY_MARKER) return path;
			if ((await readHandle(inner)).byteLength > 0) return path;
		}
	}
	return undefined;
}

/** What a folder's directory holds, read without writing anything. */
type Destination =
	| { readonly kind: 'absent' }
	| { readonly kind: 'notDirectory' }
	/** A marker with bytes, and what it records. */
	| {
			readonly kind: 'marked';
			readonly handle: OpfsDirectoryHandle;
			readonly record: MarkerRecord;
	  }
	/** No ready marker, or an empty one. `occupant` is its first entry beyond that. */
	| {
			readonly kind: 'unmarked';
			readonly handle: OpfsDirectoryHandle;
			readonly occupant: string | undefined;
	  };

async function inspectDirectory(
	origin: OpfsDirectoryHandle,
	directory: string,
): Promise<Destination> {
	const found = await lookup(origin, directory);
	if (found.kind === 'absent') return { kind: 'absent' };
	if (found.kind !== 'directory') return { kind: 'notDirectory' };
	const marker = await lookup(found.handle, MARKER_PATH);
	const bytes =
		marker.kind === 'file' ? await readHandle(marker.handle) : undefined;
	if (bytes !== undefined && bytes.byteLength > 0)
		return {
			kind: 'marked',
			handle: found.handle,
			record: markerRecord(bytes),
		};
	return {
		kind: 'unmarked',
		handle: found.handle,
		occupant: await occupant(found.handle),
	};
}

/** What a directory is to the folder at one address. */
type Standing =
	/** Missing, or empty as an interrupted first open leaves it. */
	| { readonly kind: 'empty' }
	/** Records an unfinished download, for any address. */
	| { readonly kind: 'pending'; readonly download: PendingDownload }
	/** Its ready marker names the address. */
	| {
			readonly kind: 'ready';
			readonly handle: OpfsDirectoryHandle;
			readonly marker: ReadyMarker;
	  }
	/** Not this folder's, and not empty: `reason` says why. */
	| { readonly kind: 'refused'; readonly reason: string };

function standingAt(found: Destination, address: string): Standing {
	switch (found.kind) {
		case 'absent':
			return { kind: 'empty' };
		case 'notDirectory':
			return { kind: 'refused', reason: 'is not a directory' };
		case 'unmarked':
			return found.occupant === undefined
				? { kind: 'empty' }
				: {
						kind: 'refused',
						reason: `holds '${found.occupant}' but no ready marker for ${address}`,
					};
		case 'marked': {
			const { record } = found;
			if (record.kind === 'none')
				return {
					kind: 'refused',
					reason: 'has a ready marker that names no address',
				};
			if (record.kind === 'pending')
				return { kind: 'pending', download: record.download };
			if (record.address !== address)
				return {
					kind: 'refused',
					reason: `is marked for ${record.address}, not ${address}`,
				};
			return { kind: 'ready', handle: found.handle, marker: record };
		}
	}
}

/** The remote a ready folder is bound to, as its marker and configuration say. */
type RemoteBinding =
	| { readonly kind: 'none' }
	/** `branch` is `undefined` where only the URL was recorded: a folder an earlier version made. */
	| {
			readonly kind: 'bound';
			readonly url: string;
			readonly branch: string | undefined;
	  }
	| { readonly kind: 'ambiguous'; readonly reason: string };

/**
 * Read, without writing, what remote a ready folder is bound to. The marker
 * records the URL and branch the folder was made with; an earlier version
 * recorded only `remote.origin.url` in Git configuration, which still binds
 * the URL. A marker and a configuration that name different URLs, a
 * `remote` property that is no URL and branch, and a configuration that
 * cannot be read are ambiguous: nothing says which remote the folder keeps.
 */
async function remoteBinding(
	root: OpfsDirectoryHandle,
	marker: ReadyMarker,
): Promise<RemoteBinding> {
	const ambiguous = (reason: string): RemoteBinding => ({
		kind: 'ambiguous',
		reason,
	});
	if (marker.remote.kind === 'malformed')
		return ambiguous('has a ready marker whose remote is not a URL and branch');
	const origin = await readOrigin(root);
	if (!origin.readable)
		return ambiguous('has Git configuration that cannot be read');
	if (marker.remote.kind === 'unrecorded')
		return origin.url === undefined
			? { kind: 'none' }
			: { kind: 'bound', url: origin.url, branch: undefined };
	const { url, branch } = marker.remote.remote;
	if (origin.url !== undefined && origin.url !== url)
		return ambiguous(
			'has a ready marker and Git configuration that name different remotes',
		);
	return { kind: 'bound', url, branch };
}

/**
 * Make `directory` the folder at `address`, under the folder's open lock. A
 * directory whose ready marker names `address` is the folder. One whose
 * marker names another address, records an unfinished download, or names
 * nothing, is refused, and so is one that holds anything without a marker:
 * nothing there is overwritten or adopted. A missing or empty directory
 * becomes the folder once its marker, recording `remote` if there is one, is
 * written; a marker write that fails, or whose close is unconfirmed,
 * throws, and the open is refused. An empty marker publishes nothing, so a
 * directory holding only one is still empty. Without `createIfMissing`, a
 * missing or empty directory is `Absent` and nothing is written.
 *
 * A ready folder opens with `remote` only if it is bound to that URL (and
 * branch. An older folder with no recorded branch needs explicit confirmation
 * before that branch is recorded. Another remote, a folder with none, or an
 * ambiguous binding is refused before anything is written. Opening without a
 * remote asks nothing of the binding.
 */
async function claimDirectory(
	origin: OpfsDirectoryHandle,
	directory: string,
	address: string,
	remote: GitRemote | undefined,
	createIfMissing: boolean,
	confirmLegacyRemoteBranch: boolean,
): Promise<Result<OpfsDirectoryHandle, OpenFolderError>> {
	const refused = (reason: string) =>
		OpenFolderError.Unavailable({
			cause: new Error(
				`The directory '${directory}' ${reason}; it was left unchanged`,
			),
		});
	const standing = standingAt(
		await inspectDirectory(origin, directory),
		address,
	);
	if (standing.kind === 'refused') return refused(standing.reason);
	if (standing.kind === 'pending')
		return refused(
			`${describePending(standing.download)}; downloading it again finishes it`,
		);
	if (standing.kind === 'ready') {
		if (remote === undefined) return Ok(standing.handle);
		const binding = await remoteBinding(standing.handle, standing.marker);
		if (binding.kind === 'ambiguous') return refused(binding.reason);
		const stored =
			binding.kind === 'none'
				? undefined
				: { url: binding.url, branch: binding.branch };
		if (
			stored === undefined ||
			stored.url !== remote.url ||
			(stored.branch !== remote.branch &&
				!(stored.branch === undefined && confirmLegacyRemoteBranch))
		)
			return OpenFolderError.RemoteMismatch({
				directory,
				stored,
				requested: { url: remote.url, branch: remote.branch },
			});
		if (stored?.branch === undefined)
			await writeMarker(standing.handle, { address, remote });
		return Ok(standing.handle);
	}
	if (!createIfMissing) return OpenFolderError.Absent({ directory });
	const { data: made, error: directoryError } = await ensureDirectory(
		origin,
		directory,
	);
	if (directoryError !== null)
		return OpenFolderError.Unavailable({ cause: directoryError });
	await writeMarker(made, { address, remote });
	return Ok(made);
}

/**
 * A folder's file boundary and history over `root`, with the Web Locks every
 * handle of its address shares. `relay` hears each landed step; `landed`
 * hears the paths an incoming update wrote.
 */
async function startHistory(
	root: OpfsDirectoryHandle,
	locks: OpfsLocks,
	at: FolderAddress,
	settings: {
		readonly author: Author;
		readonly remote: GitRemote | undefined;
		readonly httpFetch: HttpFetch | undefined;
		readonly definition?: FolderDefinition;
		readonly relay?: (paths: readonly string[]) => void;
		readonly landed?: (paths: readonly string[]) => void;
	},
) {
	const relay = settings.relay ?? (() => {});
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
		branch: 'main',
		remote: settings.remote,
		httpFetch: settings.httpFetch,
	});
	const history = createHistory({
		backend,
		boundary,
		author: settings.author,
		definition: settings.definition,
		landed: settings.landed,
	});
	return { boundary, backend, history };
}

/**
 * Open the browser folder named `id`. Refusals are returned, not thrown: a
 * definition a folder cannot keep, a page inside the desktop app, a missing
 * ID, missing browser storage, a remote without an author, or a directory
 * that is not this folder's.
 */
export const openFolder: OpenFolder = async ({
	definition,
	id,
	browser = {},
}) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const { createIfMissing = true } = browser;
	const { confirmLegacyRemoteBranch = false } = browser;
	// Copied before the first await, like the scope: the marker records this
	// pair, not whatever the caller's object holds later.
	const remote =
		browser.remote === undefined
			? undefined
			: { url: browser.remote.url, branch: browser.remote.branch };
	if (remote !== undefined && browser.author === undefined)
		return OpenFolderError.AuthorRequired();
	const author = browser.author ?? LOCAL_AUTHOR;
	const { httpFetch } = browser;
	const { data: captured, error: captureError } = await captureAddress(
		id,
		browser.scope,
		browser.opfs,
	);
	if (captureError !== null) return Err(captureError);
	return openOpfsFolder<typeof definition>(prepared, captured.environment, {
		at: captured.at,
		author,
		remote,
		httpFetch,
		createIfMissing,
		confirmLegacyRemoteBranch,
	});
};

async function openOpfsFolder<TDefinition extends FolderDefinition>(
	prepared: FolderDefinition,
	environment: OpfsEnvironment,
	captured: {
		readonly at: FolderAddress;
		readonly author: Author;
		readonly remote: GitRemote | undefined;
		readonly httpFetch: HttpFetch | undefined;
		readonly createIfMissing: boolean;
		readonly confirmLegacyRemoteBranch: boolean;
	},
): Promise<Result<Folder<TDefinition>, OpenFolderError>> {
	const { at } = captured;
	const { locks } = environment;
	// One open at a time decides whether the directory is the folder yet, and
	// makes a new one so.
	let ready: Result<OpfsDirectoryHandle, OpenFolderError>;
	try {
		const origin = await environment.getDirectory();
		ready = await holding(locks, at.openLock, () =>
			claimDirectory(
				origin,
				at.directory,
				at.address,
				captured.remote,
				captured.createIfMissing,
				captured.confirmLegacyRemoteBranch,
			),
		);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	const { data: root, error: readyError } = ready;
	if (readyError !== null) return Err(readyError);

	let channel: BroadcastChannel | undefined;
	let channelOpen = false;
	const release = () => {
		channelOpen = false;
		try {
			channel?.close();
		} catch {
			// A channel that will not close has nothing left to give back.
		}
	};
	try {
		// Other tabs of this origin share the directory. Each landed step is
		// told to them as it lands; this handle's own listeners hear a save
		// when it finishes.
		if (environment.BroadcastChannel !== undefined) {
			channel = new environment.BroadcastChannel(at.hintChannel);
			// A runtime that counts an open channel as pending work must not be
			// kept alive by a folder nobody closed.
			(channel as { unref?: () => void }).unref?.();
			channelOpen = true;
		}
		// A relay that fails is another tab's missed hint, never this save's
		// failure.
		const relay = (paths: readonly string[]) => {
			if (channelOpen && paths.length > 0)
				callObserver(
					'change relay',
					(landed: readonly string[]) => channel?.postMessage([...landed]),
					paths,
				);
		};
		const hints = createFileHints();
		// An incoming update a closed tab left half published stays pending:
		// opening reads it into the snapshot and never resumes it.
		const { boundary, history } = await startHistory(root, locks, at, {
			author: captured.author,
			remote: captured.remote,
			httpFetch: captured.httpFetch,
			definition: prepared,
			relay,
			landed: (paths) => hints.emit(paths),
		});
		if (channel !== undefined) {
			channel.onmessage = ({ data }) => {
				if (!channelOpen || history.snapshot.closed || !Array.isArray(data))
					return;
				history.noteEdit();
				hints.receive(data as string[]);
			};
		}
		const folder = assembleFolder<TDefinition>({
			prepared,
			storage: withPublication({
				storage: boundary,
				history,
				landed: (paths) => hints.emit(paths),
			}),
			history,
			location: { kind: 'opfs', directory: at.directory },
			hints,
			release: async () => release(),
		});
		await publishDefinition(prepared, folder.files);
		return Ok(folder);
	} catch (cause) {
		release();
		return OpenFolderError.Unavailable({ cause });
	}
}

export type InspectFolderOptions = {
	/** The folder ID within its scope, as `openFolder` takes it. */
	readonly id: string;
	/**
	 * The channel and optional captured account, as `BrowserFolderOptions.scope`:
	 * omitted is release Local. Read before the first await.
	 */
	readonly scope?: BrowserFolderOptions['scope'];
	/** Injected origin private file system and Web Locks; for tests. */
	readonly opfs?: OpfsEnvironment;
};

/**
 * The remote a ready folder is bound to. `branch` is `undefined` for a folder
 * an earlier version bound by URL alone, which recorded no branch.
 */
export type FolderRemote = {
	readonly url: string;
	readonly branch: string | undefined;
};

/** What one browser folder's directory holds, read without writing. */
export type FolderInspection =
	/** No folder: the directory is missing or empty. Opening would create one. */
	| { readonly kind: 'absent'; readonly location: FolderLocation }
	/** An unfinished download of `remote`. Opening refuses it; downloading again finishes it. */
	| {
			readonly kind: 'pending';
			readonly location: FolderLocation;
			readonly remote: GitRemote;
	  }
	/** A folder at this address. `remote` is `undefined` when it has none. */
	| {
			readonly kind: 'ready';
			readonly location: FolderLocation;
			readonly remote: FolderRemote | undefined;
	  };

/** Inspection's refusals: those of an opener that has no definition to prepare. */
export type InspectError =
	| AddressError
	| Extract<OpenFolderError, { name: 'Unavailable' }>;

/**
 * Report what the directory of folder `id` holds, without creating or writing
 * anything: no directory, marker, Git state, or `epicenter.json`, and the
 * folder is not opened. The scope and address rules are `openFolder`'s, and
 * the decision is made under the same open Web Lock, so it is the one an
 * opener would reach and it never observes a marker claim or download midway.
 * A directory that is not this folder's, or whose binding cannot be told, is
 * `Unavailable`, as `openFolder` refuses it.
 */
export async function inspectFolder({
	id,
	scope,
	opfs,
}: InspectFolderOptions): Promise<Result<FolderInspection, InspectError>> {
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const { data: captured, error: captureError } = await captureAddress(
		id,
		scope,
		opfs,
	);
	if (captureError !== null) return Err(captureError);
	const { environment, at } = captured;
	try {
		const origin = await environment.getDirectory();
		return await holding(environment.locks, at.openLock, () =>
			inspectAt(origin, at),
		);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
}

async function inspectAt(
	origin: OpfsDirectoryHandle,
	at: FolderAddress,
): Promise<Result<FolderInspection, InspectError>> {
	const { directory } = at;
	const location: FolderLocation = { kind: 'opfs', directory };
	const refused = (reason: string) =>
		OpenFolderError.Unavailable({
			cause: new Error(
				`The directory '${directory}' ${reason}; it was left unchanged`,
			),
		});
	const standing = standingAt(
		await inspectDirectory(origin, directory),
		at.address,
	);
	switch (standing.kind) {
		case 'empty':
			return Ok({ kind: 'absent', location });
		case 'refused':
			return refused(standing.reason);
		case 'pending': {
			const { download } = standing;
			// A record for another address is not this folder's download.
			if (download.address !== at.address)
				return refused(describePending(download));
			return Ok({ kind: 'pending', location, remote: { ...download.remote } });
		}
		case 'ready': {
			const binding = await remoteBinding(standing.handle, standing.marker);
			if (binding.kind === 'ambiguous') return refused(binding.reason);
			return Ok({
				kind: 'ready',
				location,
				remote:
					binding.kind === 'none'
						? undefined
						: { url: binding.url, branch: binding.branch },
			});
		}
	}
}

export type DownloadFolderOptions = {
	/** The folder ID within its scope, as `openFolder` takes it. */
	readonly id: string;
	/**
	 * The channel and optional captured account the folder will be opened
	 * with. No account means Local. Read before the first await; a later
	 * login change does not retarget it. The scope itself is required.
	 */
	readonly scope: {
		readonly channel: 'release' | 'development';
		readonly account?: AccountIdentity;
	};
	/** The paired repository and branch; saved as the folder's `origin`. */
	readonly remote: GitRemote;
	/**
	 * Fetch-compatible HTTP transport for this download only, as
	 * `BrowserFolderOptions.httpFetch`. Defaults to global fetch. Never stored.
	 */
	readonly httpFetch?: HttpFetch;
	/** Aborting stops the download as `Incomplete`, cancelling its transfer. */
	readonly signal?: AbortSignal;
	/** Injected origin private file system and Web Locks; for tests. */
	readonly opfs?: OpfsEnvironment;
};

export type FolderDownload = {
	/**
	 * The commit local `main` now names: the remote branch's head. `undefined`
	 * when the remote has no such branch: `main` is unborn, and the folder
	 * holds no files.
	 */
	readonly head: string | undefined;
	readonly location: FolderLocation;
};

/** A download's own failures, and the refusals it shares with opening. */
export type DownloadError = DownloadFolderError | AddressError;

/**
 * Make the folder `id` in the explicit scope from `remote`'s history before
 * anything opens it. No `epicenter.json` is published; open the
 * folder afterward. The marker records the pending download (address, URL,
 * branch) before any Git state is written and becomes the ready marker last.
 * A destination that is already a folder, holds anything else, or records
 * another download is refused unchanged (`Exists`). The address's open lock
 * is held throughout, so an opener of the same address waits and then opens
 * what landed. A download that stops is `Incomplete` and keeps what it wrote;
 * the opener refuses a pending download, and downloading again with the same
 * address, URL, and branch continues it.
 */
export async function downloadFolder({
	id,
	scope,
	remote,
	httpFetch,
	signal,
	opfs,
}: DownloadFolderOptions): Promise<Result<FolderDownload, DownloadError>> {
	if (isTauri()) return OpenFolderError.InsideTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	if (scope === undefined || scope === null)
		return OpenFolderError.InvalidBrowserScope({
			reason: 'a download needs an explicit scope',
		});
	const transfer = { remote: { ...remote }, httpFetch, signal };
	const { data: captured, error: captureError } = await captureAddress(
		id,
		scope,
		opfs,
	);
	if (captureError !== null) return Err(captureError);
	const { environment, at } = captured;
	try {
		const origin = await environment.getDirectory();
		return await environment.locks.request(at.openLock, { signal }, () =>
			downloadInto(origin, environment.locks, at, transfer),
		);
	} catch (cause) {
		return DownloadFolderError.Incomplete({
			directory: at.directory,
			cause: signal?.aborted ? signal.reason : cause,
		});
	}
}

/**
 * The `origin` URL a directory's Git configuration names. A configuration
 * with no `origin` is readable and has no URL; one that cannot be read is not
 * readable, which is not the same as having none.
 */
async function readOrigin(
	root: OpfsDirectoryHandle,
): Promise<
	| { readonly readable: true; readonly url: string | undefined }
	| { readonly readable: false }
> {
	try {
		const value: unknown = await git.getConfig({
			fs: createOpfsGitSession(root).fs,
			gitdir: GITDIR,
			path: 'remote.origin.url',
		});
		return {
			readable: true,
			url: typeof value === 'string' ? value : undefined,
		};
	} catch {
		return { readable: false };
	}
}

/** The `origin` URL a directory's Git configuration names, if it can be read. */
async function configuredOrigin(
	root: OpfsDirectoryHandle,
): Promise<string | undefined> {
	const origin = await readOrigin(root);
	return origin.readable ? origin.url : undefined;
}

/** The first entry of `root` that is not its private `.git`. */
async function folderEntry(
	root: OpfsDirectoryHandle,
): Promise<string | undefined> {
	for await (const entry of root.values())
		if (entry.name !== PRIVATE_DIRECTORY) return entry.name;
	return undefined;
}

/**
 * Inside the open lock: refuse a destination this download does not own,
 * record the pending download in the marker before any Git state exists,
 * then fetch, fast-forward the unborn `main`, and replace the record with
 * the ready marker. A directory whose marker records this exact download
 * (address, URL, and branch) is continued: an incoming update it left
 * pending is recovered first. Nothing else is adopted.
 */
async function downloadInto(
	origin: OpfsDirectoryHandle,
	locks: OpfsLocks,
	at: FolderAddress,
	{
		remote,
		httpFetch,
		signal,
	}: {
		readonly remote: GitRemote;
		readonly httpFetch: HttpFetch | undefined;
		readonly signal: AbortSignal | undefined;
	},
): Promise<Result<FolderDownload, DownloadFolderError>> {
	const { directory } = at;
	const exists = (reason: string, configured: string | undefined) =>
		DownloadFolderError.Exists({ directory, reason, origin: configured });
	const incomplete = (cause: unknown) =>
		DownloadFolderError.Incomplete({
			directory,
			cause: signal?.aborted ? signal.reason : cause,
		});
	const download: PendingDownload = {
		address: at.address,
		remote: { url: remote.url, branch: remote.branch },
	};
	const found = await inspectDirectory(origin, directory);
	if (found.kind === 'notDirectory')
		return exists('is not a directory', undefined);
	if (found.kind === 'unmarked' && found.occupant !== undefined)
		return exists(
			`holds '${found.occupant}' without a ready marker`,
			await configuredOrigin(found.handle),
		);
	let root: OpfsDirectoryHandle;
	if (found.kind === 'marked') {
		const { record } = found;
		const ours =
			record.kind === 'pending' &&
			record.download.address === download.address &&
			record.download.remote.url === download.remote.url &&
			record.download.remote.branch === download.remote.branch;
		if (!ours)
			return exists(
				record.kind === 'ready'
					? record.address === at.address
						? 'is this folder'
						: `has a ready marker for ${record.address}`
					: record.kind === 'pending'
						? describePending(record.download)
						: 'has a ready marker that names no address',
				await configuredOrigin(found.handle),
			);
		root = found.handle;
	} else {
		// Absent, or empty as an interrupted first open or record write
		// leaves it. The record is confirmed before Git state exists, so
		// anything a later step writes is this download's.
		const { data: made, error: directoryError } =
			found.kind === 'unmarked'
				? Ok(found.handle)
				: await ensureDirectory(origin, directory);
		if (directoryError !== null) return incomplete(directoryError);
		try {
			await writeMarker(made, { download });
		} catch (cause) {
			return incomplete(
				new Error(
					'The record of this pending download was not confirmed; nothing else was written',
					{ cause },
				),
			);
		}
		root = made;
	}

	const { backend, history } = await startHistory(root, locks, at, {
		author: LOCAL_AUTHOR,
		remote,
		httpFetch,
	});
	// Closing the history aborts its transfer; the step that was running
	// returns, and the download reports the signal's reason.
	const stop = () => void history.close();
	signal?.addEventListener('abort', stop, { once: true });
	try {
		if (signal?.aborted) return incomplete(signal.reason);
		const { error: recoverError } = await history.recoverIncoming();
		if (recoverError !== null) return incomplete(recoverError);
		const { data: fetched, error: fetchError } = await history.fetch();
		if (fetchError !== null) return incomplete(fetchError);
		// A fetch that finds no branch leaves the tracking ref an earlier
		// attempt fetched. Pulls read that ref, so a folder marked ready over
		// it would later adopt history the remote no longer has.
		const tracked = await backend.readRemoteTracking();
		if (tracked !== fetched.oid)
			return incomplete(
				new Error(
					`refs/remotes/origin/${remote.branch} still names ${tracked ?? 'nothing'}, which the remote no longer advertises (it advertises ${fetched.oid ?? 'no such branch'}); the cached ref was kept`,
				),
			);
		if (fetched.oid === undefined) {
			const head = await backend.readBranch();
			if (head !== undefined)
				return incomplete(
					new Error(
						`The remote has no branch '${remote.branch}', but main already names ${head}`,
					),
				);
			// No fast-forward runs, so nothing else checks the folder is clean.
			const entry = await folderEntry(root);
			if (entry !== undefined)
				return incomplete(
					new Error(
						`The remote has no branch '${remote.branch}', but the folder holds '${entry}', which this download did not write; it was kept`,
					),
				);
		} else {
			const { data: pulled, error: pullError } =
				await history.pullFastForward();
			if (pullError !== null) return incomplete(pullError);
			if (pulled.status === 'ahead')
				return incomplete(
					new Error(
						`main names ${pulled.head}, which already contains the remote head ${fetched.oid}`,
					),
				);
		}
		if (signal?.aborted) return incomplete(signal.reason);
		try {
			await writeMarker(root, {
				address: at.address,
				remote: download.remote,
			});
		} catch (cause) {
			return incomplete(
				new Error(
					'The ready marker was not confirmed; the folder may be ready. Opening with createIfMissing: false, or downloading again, shows which',
					{ cause },
				),
			);
		}
		return Ok({
			head: fetched.oid,
			location: { kind: 'opfs', directory },
		});
	} catch (cause) {
		return incomplete(cause);
	} finally {
		signal?.removeEventListener('abort', stop);
		await history.close();
	}
}
