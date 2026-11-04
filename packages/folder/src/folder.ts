/**
 * The folder `openFolder(contract)` returns, on every build (ADR-0766,
 * ADR-0767): handed over at once, already opening, with its lifecycle as
 * synchronous state and its collections directly on it (`folder.todos`).
 *
 * - `state()` is `opening`, `open`, `failed` with the typed open error and
 *   the `retry()` that opens again, or `closed` once disposed: the same
 *   object until it changes, and `subscribe` hears it change.
 * - A collection's reads answer at every moment: `items()` is empty and
 *   `loading()` true while the folder opens.
 * - Every async method waits for the open, then runs. When the open fails it
 *   answers `Err(OpenFolderError)`, so each action's error type includes the
 *   open's; a retry starts a new attempt for the actions called after it.
 *
 * Only an interface reads `state()` (`<WhenOpen>` from `@epicenter/svelte`);
 * everything else reads and acts, and its actions wait.
 *
 * This module is the same on every build; each build's `openFolder` hands
 * `createFolder` the open that build has (the shell's data folder, this
 * browser's storage, the account's copy, or memory under `test`).
 */
import {
	type Client,
	type ClientError,
	type Collection,
	type Contract,
	compileContract,
	type FileClient,
	type FileEntryOf,
	type InvalidNoteOf,
	type NoteClient,
	type NoteOf,
	type Version,
} from '@epicenter/definition/contract';
import { sameValue } from '@epicenter/definition/note';
import type { InferError } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { OpenFolderError, type RevealRootError } from './errors.js';

export { OpenFolderError } from './errors.js';

/** Why the folder's place could not be shown. */
export type RevealFolderError = RevealRootError;

const log = createLogger('folder');

type Unavailable = InferError<typeof ClientError.Unavailable>;

/**
 * Where the folder is in its life. Retrying belongs to a failure, so only
 * the failed state carries `retry()`.
 */
export type FolderState =
	| { readonly status: 'opening' }
	| { readonly status: 'open' }
	| {
			readonly status: 'failed';
			readonly error: OpenFolderError;
			/** Open again; does nothing once the folder moved on. */
			retry(): void;
	  }
	| { readonly status: 'closed' };

/**
 * A collection method that waits for the open: the same arguments, and its
 * answer or the open's typed error.
 */
type Waits<TMethods> = {
	[K in keyof TMethods]: TMethods[K] extends (
		...args: infer TArgs
	) => Promise<Result<infer TData, infer TError>>
		? (...args: TArgs) => Promise<Result<TData, TError | OpenFolderError>>
		: TMethods[K];
};

/**
 * The reads every collection of a folder answers at once, and the one way
 * to hear them change. While something listens, the collection is listed,
 * and listed again after every change to its files.
 */
type Reads<TItem> = {
	/** The entries as last listed, and written here since; empty until the first listing. */
	items(): readonly TItem[];
	/** True until the first listing answers, which waits for the open. */
	loading(): boolean;
	/** Why the last listing failed (the open's error, when it failed); null once one answers. What was listed stays. */
	error(): Unavailable | OpenFolderError | null;
	/**
	 * Call `listener` when a read may answer differently; returns the
	 * unsubscribe. The first listener starts listing, the last one's
	 * unsubscribe stops it.
	 */
	subscribe(listener: () => void): () => void;
};

/** A note collection of a folder: its reads, and the client's methods, each waiting for the open. */
export type FolderNotes<TCollection extends Collection> = Waits<
	Omit<NoteClient<TCollection>, 'subscribe'>
> &
	Reads<NoteOf<TCollection>> & {
		/** The notes at the collection's paths that do not read, with their text. */
		invalid(): readonly InvalidNoteOf<TCollection>[];
	};

/** A file collection of a folder: its reads (entries without bytes), and the client's methods, each waiting for the open. */
export type FolderFiles<TCollection extends Collection> = Waits<
	Omit<FileClient<TCollection>, 'subscribe'>
> &
	Reads<FileEntryOf<TCollection>>;

/** A folder's collection: notes for a path ending in `.md`, files for any other. */
export type FolderCollection<TCollection extends Collection> =
	TCollection['path'] extends `${string}.md`
		? FolderNotes<TCollection>
		: FolderFiles<TCollection>;

/** The folder's own members, beside its collections. */
export type FolderLifecycle = {
	/** Where the folder is in its life: the same object until it changes. */
	state(): FolderState;
	/** Call `listener` when `state()` changes; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Show the folder's place in the file manager, even when it did not open:
	 * the desktop's data folder. Null where there is no such place (this
	 * browser's storage, the account's copy, memory).
	 */
	readonly reveal: (() => Promise<Result<null, RevealFolderError>>) | null;
	/**
	 * Where the folder is, to show a person: the desktop data folder's path
	 * as the shell named it, once it opened. Null before, and where the
	 * folder has no path (this browser's storage, the account's copy,
	 * memory). No command takes it.
	 */
	displayPath(): string | null;
	/** Close what the folder opened: `state()` is `closed`, and every later action is `Unavailable`. */
	[Symbol.dispose](): void;
};

/** An app's folder: its lifecycle, and one collection per collection of its contract. */
export type Folder<TContract extends Contract> = FolderLifecycle & {
	readonly [K in keyof TContract['collections']]: FolderCollection<
		TContract['collections'][K]
	>;
};

/**
 * What every build's `openFolder` takes. `site` is the app's production
 * site: on the desktop the folder's `AGENTS.md` links its published
 * contract, and on the web it names the account's repository. `account`
 * selects the account's copy on the web; the desktop opens its folder
 * whatever is passed, and Epicenter syncs it.
 */
export type OpenFolderOptions = {
	site: string;
	account?: FolderAccount;
};

/**
 * The account a web folder opens the copy of: any `@epicenter/account`
 * auth client. The folder opens once it has an account, and keeps that
 * account for its life; a new account is a new page.
 */
export type FolderAccount = {
	getState(): {
		account?:
			| {
					readonly baseURL: string;
					readonly signal: AbortSignal;
					fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response>;
			  }
			| undefined;
	};
	subscribe(listener: () => void): () => void;
};

/** `openFolder` on every build: one signature, so either build's code typechecks against one. */
export type OpenFolder = <TContract extends Contract>(
	contract: TContract,
	options?: OpenFolderOptions,
) => Folder<TContract>;

/** The lifecycle members, which no collection may be named. */
const RESERVED = new Set(['state', 'subscribe', 'reveal', 'displayPath']);

/** An open that answers the client, or why nothing opened. */
export type FolderOpen<TContract extends Contract> = () => Promise<
	Result<Client<TContract>, OpenFolderError>
>;

/**
 * The folder over `open`, which is called now, and again on each retry
 * after a failure. `close` releases a client that opened once the folder is
 * disposed, even one that opens after; `reveal` shows the folder's place,
 * where it has one. A contract with a collection named like a lifecycle
 * member throws.
 */
export function createFolder<TContract extends Contract>(
	contract: TContract,
	open: FolderOpen<TContract>,
	{
		close = () => {},
		reveal = null,
		displayPath = () => null,
	}: {
		close?: (client: Client<TContract>) => void;
		reveal?: FolderLifecycle['reveal'];
		displayPath?: FolderLifecycle['displayPath'];
	} = {},
): Folder<TContract> {
	const { data: compiled, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });
	return folderOver(
		compiled.collections.map(({ name, kind, keys }) => ({ name, kind, keys })),
		open,
		{ close, reveal, displayPath },
	);
}

/**
 * A folder over `client`, which is already open: open at once, and its
 * collections read and act as any folder's. Disposing it stops its
 * listings and closes nothing: the client is its opener's. What
 * `fromClient` from `@epicenter/svelte/client` makes of a client a remote
 * or `openDevice` opened.
 */
export function folderOf<TContract extends Contract>(
	client: Client<TContract>,
): Folder<TContract> {
	const declared = Object.entries(client as Record<string, Raw>).map(
		([name, collection]): Declared =>
			'replace' in collection
				? { name, kind: 'note', keys: collection.fieldNames }
				: { name, kind: 'file', keys: [] },
	);
	return folderOver(declared, async () => Ok(client), {
		close: () => {},
		reveal: null,
		displayPath: () => null,
	});
}

/** A collection as a folder needs it: its name, its kind, and a note's declared fields. */
type Declared = {
	name: string;
	kind: 'note' | 'file';
	keys: readonly string[];
};

/** The folder over `open`, with one collection per `declared`. */
function folderOver<TContract extends Contract>(
	declared: Declared[],
	open: FolderOpen<TContract>,
	{
		close,
		reveal,
		displayPath,
	}: {
		close: (client: Client<TContract>) => void;
		reveal: FolderLifecycle['reveal'];
		displayPath: FolderLifecycle['displayPath'];
	},
): Folder<TContract> {
	type Opened = Result<Client<TContract>, OpenFolderError>;
	let state: FolderState = { status: 'opening' };
	let attempt: Promise<Opened>;
	let disposed = false;
	const listeners = new Set<() => void>();
	const collections = new Map<string, ReturnType<typeof folderCollection>>();

	function set(next: FolderState) {
		state = next;
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A folder subscriber failed.', { cause }));
			}
	}

	function start() {
		const opening = open().catch(
			(cause: unknown): Opened => OpenFolderError.StorageUnavailable({ cause }),
		);
		attempt = opening;
		void opening.then((opened) => {
			// Disposing closes what this attempt opens.
			if (disposed || attempt !== opening) return;
			set(
				opened.error === null
					? { status: 'open' }
					: { status: 'failed', error: opened.error, retry: retryFailure() },
			);
			for (const collection of collections.values()) collection.opened();
		});
	}

	/** A failure's retry: it opens again only while that failure is the state. */
	function retryFailure() {
		const retry = () => {
			if (disposed || state.status !== 'failed' || state.retry !== retry)
				return;
			set({ status: 'opening' });
			start();
		};
		return retry;
	}

	const current = () => attempt;

	for (const collection of declared) {
		if (RESERVED.has(collection.name))
			throw new Error(
				`A folder cannot have a collection named ${collection.name}: it is the folder's own.`,
			);
		collections.set(
			collection.name,
			folderCollection(collection, current as () => Promise<Opened>),
		);
	}
	start();

	const lifecycle: FolderLifecycle = {
		state: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reveal,
		displayPath,
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			set({ status: 'closed' });
			listeners.clear();
			for (const collection of collections.values()) collection.stop();
			void attempt.then((opened) => {
				if (opened.error === null) close(opened.data);
			});
		},
	};
	return Object.assign(
		lifecycle,
		Object.fromEntries(
			[...collections].map(([name, { collection }]) => [name, collection]),
		),
	) as Folder<TContract>;
}

/** An entry as listed: its placeholders, fields and version. */
type Entry = { [key: string]: unknown; version: Version };
type Args = Record<string, unknown>;
/** Either kind of collection client, as this module calls it. */
type Raw = NoteClient<Collection> | FileClient<Collection>;
type Answer = Result<unknown, { name: string }>;

/** How long after a failed listing it is tried again, doubling per failure up to the most. */
const RETRY_FIRST_MS = 500;
const RETRY_MOST_MS = 30_000;

/** Whether `entry` is the one `args` (placeholders, or a created value) names. */
const names = (entry: Entry, args: Args) =>
	Object.entries(args).every(
		([key, value]) => key === 'bytes' || sameValue(entry[key], value),
	);

/**
 * The collection `declared` names in the client `current()` answers: its
 * methods, each waiting for the open, and its reads, listed while someone
 * listens. `opened()` is told each time an open attempt settles, and
 * `stop()` when the folder is disposed.
 */
function folderCollection(
	declared: Declared,
	current: () => Promise<Result<Client<Contract>, OpenFolderError>>,
) {
	const { name } = declared;
	let items: Entry[] = [];
	let invalid: Entry[] = [];
	let loading = true;
	let error: Unavailable | OpenFolderError | null = null;
	const listeners = new Set<() => void>();
	/** The open collection's own change source, while someone listens. */
	let stopSource: (() => void) | undefined;
	/** Waiting for the open before following it. */
	let following = false;
	let listing = false;
	let again = false;
	/** Listings that failed in a row, and the try after the last one. */
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;

	/** The collection's client once the folder opened, or why it did not. */
	async function raw(): Promise<Result<Raw, OpenFolderError>> {
		const opened = await current();
		if (opened.error !== null) return opened;
		return Ok(opened.data[name] as Raw);
	}

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A collection subscriber failed.', { cause }));
			}
	}

	/** List again, as long as changes keep arriving while a listing runs. */
	async function reload() {
		clearTimeout(retry);
		retry = undefined;
		if (listing) {
			again = true;
			return;
		}
		listing = true;
		try {
			do {
				again = false;
				const collection = await raw();
				const listed =
					collection.error === null ? await collection.data.list() : collection;
				if (again) continue;
				if (listed.error !== null) {
					error = listed.error;
					failures++;
				} else {
					items = listed.data.items as Entry[];
					invalid = (
						'invalid' in listed.data ? listed.data.invalid : []
					) as Entry[];
					error = null;
					failures = 0;
				}
				loading = false;
				notify();
			} while (again);
		} finally {
			listing = false;
		}
		// A failed open is tried again by its state's `retry()`, not by the listing.
		if (failures > 0 && listeners.size > 0 && error?.name === 'Unavailable')
			retry = setTimeout(
				() => void reload(),
				Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MOST_MS),
			);
	}

	/**
	 * Follow the open collection's changes and list it, once the folder
	 * opened and while someone listens; after a failed open, list to show
	 * why, and follow again when an attempt settles (`opened`).
	 */
	async function follow() {
		if (following || stopSource !== undefined) return;
		following = true;
		const collection = await raw();
		following = false;
		if (listeners.size === 0 || stopSource !== undefined) return;
		if (collection.error === null)
			stopSource = collection.data.subscribe(() => void reload());
		void reload();
	}

	function unfollow() {
		stopSource?.();
		stopSource = undefined;
		clearTimeout(retry);
		retry = undefined;
		failures = 0;
	}

	/** Show `entry` where `args` named one, or as a new one. */
	function put(entry: Entry, args: Args) {
		const at = items.findIndex((item) => names(item, args));
		items = at === -1 ? [...items, entry] : items.with(at, entry);
		invalid = invalid.filter((item) => !names(item, args));
		notify();
	}

	/** Show nothing where `args` named something. */
	function drop(args: Args) {
		items = items.filter((item) => !names(item, args));
		invalid = invalid.filter((item) => !names(item, args));
		notify();
	}

	/**
	 * After a write, show what it answered: what landed, or, after a
	 * `Conflict` or `NotFound`, what is there now (a note read again, files
	 * listed again).
	 */
	async function settle<T extends Answer>(
		collection: Raw,
		args: Args,
		written: T,
	): Promise<T> {
		if (written.error === null) {
			if (written.data === undefined) drop(args);
			else put(written.data as Entry, args);
			return written;
		}
		if (written.error.name !== 'Conflict' && written.error.name !== 'NotFound')
			return written;
		if (!('replace' in collection)) {
			if (listeners.size > 0) void reload();
			return written;
		}
		const now = await collection.get(args as never);
		if (now.error === null) put(now.data as Entry, args);
		else if (now.error.name === 'NotFound') drop(args);
		return written;
	}

	/** `method` of the open collection, called with `args`; its answer shown when `shown` says how. */
	function waiting(
		method: 'list' | 'get' | 'create' | 'update' | 'replace' | 'delete',
		shown: (args: unknown[]) => Args | null,
	) {
		return async (...args: unknown[]) => {
			const collection = await raw();
			if (collection.error !== null) return collection;
			const methods = collection.data as unknown as Record<
				typeof method,
				(...args: unknown[]) => Promise<Answer>
			>;
			const answer = await methods[method](...args);
			const named = shown(args);
			return named === null ? answer : settle(collection.data, named, answer);
		};
	}

	const reads = {
		items: () => items,
		loading: () => loading,
		error: () => error,
		subscribe(listener: () => void) {
			listeners.add(listener);
			if (listeners.size === 1) void follow();
			return () => {
				if (!listeners.delete(listener) || listeners.size > 0) return;
				unfollow();
			};
		},
	};
	const methods = {
		list: waiting('list', () => null),
		get: waiting('get', () => null),
		create: waiting('create', ([value]) => value as Args),
		update: waiting('update', ([args]) => args as Args),
		delete: waiting('delete', ([args]) => args as Args),
	};
	const collection =
		declared.kind === 'note'
			? {
					fieldNames: declared.keys,
					...reads,
					invalid: () => invalid,
					...methods,
					replace: waiting('replace', ([args]) => args as Args),
				}
			: { ...reads, ...methods };

	return {
		collection,
		/** An open attempt settled: follow it for whoever listens. */
		opened() {
			if (listeners.size > 0) void follow();
		},
		stop() {
			listeners.clear();
			unfollow();
		},
	};
}
