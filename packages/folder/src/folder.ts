/**
 * The folder `openFolder(contract, place)` returns, on every build (ADR-0766,
 * ADR-0767, ADR-0773): handed over at once, already opening, with its lifecycle as
 * synchronous state and its collections directly on it (`folder.todos`).
 *
 * - `state()` is `opening`, `open`, `failed` with the typed open error and
 *   the `retry()` that opens again, or `closed` once disposed: the same
 *   object until it changes, and `subscribe` hears it change.
 * - `saving()` is whether a write is out, from the call (or the keystroke)
 *   until it answers; `subscribe` hears it start and stop, so a page's
 *   leave guard reads it instead of counting writes of its own.
 * - A collection's reads answer at every moment: `items()` is empty and
 *   `loading()` true while the folder opens, and `get(args)` is the entry
 *   shown.
 * - Every write is made over the version shown, unless it names another,
 *   and puts what landed into what is shown before it answers. A note
 *   `update` follows `updateNote`: carried over another writer's change to
 *   other fields; a `Conflict` when they changed the same one, and then the
 *   folder shows theirs, so saving again applies over it.
 * - A note write's refusal (`Conflict`, `NotFound`, a create's `Occupied`)
 *   answers only once the folder shows what refused it: `get(args)` after
 *   the answer is the note there now. When it cannot be read again, the
 *   write answers `Unavailable` instead. A file collection does not keep
 *   this promise yet: it answers the refusal and lists again behind it.
 * - Every async method waits for the open, then runs. When the open fails it
 *   answers `Err(OpenFolderError)`, so each action's error type includes the
 *   open's; a retry starts a new attempt for the actions called after it.
 *   Once the folder is disposed, every action answers `Unavailable`, one
 *   still waiting for the open included.
 * - `notes.edit(args)` is one note as an immediate editor (`NoteEdit`).
 *
 * Only an interface reads `state()` (`<WhenOpen>` from `@epicenter/svelte`);
 * everything else reads and acts, and its actions wait. Nothing here knows a
 * framework: `reactive(folder)` from `@epicenter/svelte/reactive` tracks the
 * reads as they are.
 *
 * This module is the same on every build: `openFolder` hands `createFolder`
 * the open of a place (the desktop's data folder, this browser's storage,
 * the account's repository, a directory, or memory under `test`), as the
 * typed client over that place's store.
 */
import {
	type Client,
	ClientError,
	type Collection,
	type Contract,
	compileContract,
	type FileClient,
	type FileEntryOf,
	type InvalidNoteOf,
	type NoteClient,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
	updateNote,
	type Version,
} from '@epicenter/definition/contract';
import { sameValue } from '@epicenter/definition/note';
import type { InferError } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { OpenFolderError, type RevealRootError } from './errors.js';
import { editNote, type NoteEdit, type NoteEditOptions } from './note-edit.js';

export { OpenFolderError } from './errors.js';
export type { NoteEdit, NoteEditOptions } from './note-edit.js';

/** Why the folder's place could not be shown. */
export type RevealFolderError = RevealRootError;

const log = createLogger('folder');

type Unavailable = InferError<typeof ClientError.Unavailable>;
type Occupied = InferError<typeof ClientError.Occupied>;
type NotFound = InferError<typeof ClientError.NotFound>;

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
			/**
			 * Open again, answering once that attempt settles; does nothing,
			 * and answers at once, when the folder moved on.
			 */
			retry(): Promise<void>;
	  }
	| { readonly status: 'closed' };

/** What `TMethod` answers, or the open's typed error: a folder's method waits for the open. */
type Waits<TMethod> = TMethod extends (
	...args: never[]
) => Promise<Result<infer TData, infer TError>>
	? Promise<Result<TData, TError | OpenFolderError>>
	: never;

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

/** A note as shown, or the version and fields an edit was made over. */
export type NoteBase<TCollection extends Collection> = {
	version: Version;
} & NotePatch<TCollection>;

/**
 * A note collection of a folder: its reads, and its writes, each waiting
 * for the open and made over the note as shown unless told otherwise.
 *
 * A write's refusal (`Conflict`, `NotFound`, a create's `Occupied`) answers
 * only once `get(args)` shows what refused it: the note read again, or
 * nothing when it is gone. When that read answers `Unavailable` the write
 * answers it instead, so a refusal always means the folder shows its
 * reason. A note there that does not read keeps the refusal.
 */
export type FolderNotes<TCollection extends Collection> = Reads<
	NoteOf<TCollection>
> & {
	/** The fields the contract declares, in its order: an editor's `fields` are these and `body`. */
	fieldNames: NoteClient<TCollection>['fieldNames'];
	/** The notes at the collection's paths that do not read, with their text. */
	invalid(): readonly InvalidNoteOf<TCollection>[];
	/** The note `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): NoteOf<TCollection> | undefined;
	/** Every note, read now. */
	list(): Waits<NoteClient<TCollection>['list']>;
	create(
		value: Parameters<NoteClient<TCollection>['create']>[0],
	): Waits<NoteClient<TCollection>['create']>;
	/**
	 * Write `patch` over `base`, by default the note as shown: what a person
	 * acting on what they see saw. An editor that shows typed text instead
	 * passes what was shown when the typing began (`edit` does).
	 */
	update(
		args: PlaceholdersOf<TCollection>,
		patch: NotePatch<TCollection>,
		options?: { base?: NoteBase<TCollection> },
	): Waits<NoteClient<TCollection>['update']>;
	/**
	 * Replace the whole note with `text`, over `over`, by default the version
	 * shown (valid or not). An editor that shows a draft passes the version
	 * its draft began from, so another writer's change since is a `Conflict`
	 * (the folder then shows theirs), not overwritten.
	 */
	replace(
		args: PlaceholdersOf<TCollection>,
		text: string,
		options?: { over?: Version },
	): Waits<NoteClient<TCollection>['replace']>;
	/** Delete the note, over `over`, by default the version shown. */
	delete(
		args: PlaceholdersOf<TCollection>,
		options?: { over?: Version },
	): Waits<NoteClient<TCollection>['delete']>;
	/**
	 * The note `args` names as an immediate editor (`NoteEdit`).
	 *
	 * Saves go one at a time, and only the newest waiting is sent, carrying
	 * every field typed since the last save that landed; only the newest
	 * save's answer is shown. Each is made over the note as shown when this
	 * run of typing began (each field as shown when its own typing began),
	 * then over the editor's own last save that landed, so the editor never
	 * clashes with itself, another writer's change to fields not typed is
	 * carried over, and their change to a typed field surfaces as a
	 * `Conflict` (the folder then shows theirs) with the typed text kept.
	 * Saving again after that (`retry`, or typing on) applies over theirs.
	 * Each keystroke counts in the folder's `saving()` from the moment it is
	 * typed until its save answers.
	 *
	 * With `create`, the note need not exist yet: a save while none is shown
	 * creates it, with `create()`'s fields and what was typed (a draft that
	 * starts with its first keystroke). When another writer created it first
	 * (`Occupied`), what was typed is written over theirs as an ordinary save.
	 */
	edit(
		args: PlaceholdersOf<TCollection>,
		options?: NoteEditOptions<TCollection>,
	): NoteEdit<TCollection>;
};

/** A file collection of a folder: its reads (entries without bytes), and its writes, each waiting for the open. */
export type FolderFiles<TCollection extends Collection> = Reads<
	FileEntryOf<TCollection>
> & {
	/** The entry `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): FileEntryOf<TCollection> | undefined;
	/** The file `args` names with its bytes, read now. */
	read(
		args: PlaceholdersOf<TCollection>,
	): Waits<FileClient<TCollection>['get']>;
	/** Every entry, read now. */
	list(): Waits<FileClient<TCollection>['list']>;
	create(
		value: Parameters<FileClient<TCollection>['create']>[0],
	): Waits<FileClient<TCollection>['create']>;
	/** Write `patch` over `over`, by default the version shown. */
	update(
		args: PlaceholdersOf<TCollection>,
		patch: { bytes: Uint8Array },
		options?: { over?: Version },
	): Waits<FileClient<TCollection>['update']>;
	/** Delete the file, over `over`, by default the version shown. */
	delete(
		args: PlaceholdersOf<TCollection>,
		options?: { over?: Version },
	): Waits<FileClient<TCollection>['delete']>;
	/**
	 * Add `bytes` to the end of the file `args` names, for a file written
	 * while it is made, such as a recording. With `create` the file is made
	 * with these bytes, never over one that is there (`Occupied`); without,
	 * the bytes go after what is there (`NotFound` when it went). Listeners
	 * hear the file when it is made, and after that only an append with
	 * `announce`. Only this browser's storage appends: anywhere else the
	 * answer is `Unavailable`.
	 */
	append(
		args: PlaceholdersOf<TCollection>,
		bytes: Uint8Array,
		options: { create: boolean; announce: boolean },
	): Promise<
		Result<undefined, Occupied | NotFound | Unavailable | OpenFolderError>
	>;
};

/** A folder's collection: notes for a path ending in `.md`, files for any other. */
export type FolderCollection<TCollection extends Collection> =
	TCollection['path'] extends `${string}.md`
		? FolderNotes<TCollection>
		: FolderFiles<TCollection>;

/** The folder's own members, beside its collections. */
export type FolderLifecycle = {
	/** Where the folder is in its life: the same object until it changes. */
	state(): FolderState;
	/**
	 * Whether a write is out: a collection's write from its call, or an
	 * editor's keystroke, until it answers. A page's leave guard reads it.
	 */
	saving(): boolean;
	/** Call `listener` when `state()`, `saving()` or `displayPath()` changes; returns the unsubscribe. */
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

/** The lifecycle members, which no collection may be named. */
const RESERVED = new Set([
	'state',
	'saving',
	'subscribe',
	'reveal',
	'displayPath',
]);

/** What an action runs on: the open client, why nothing opened, or `Unavailable` once disposed. */
type Current<TContract extends Contract> = Result<
	Client<TContract>,
	OpenFolderError | Unavailable
>;

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
	type Opened = Result<Client<TContract>, OpenFolderError>;
	let state: FolderState = { status: 'opening' };
	let attempt: Promise<Opened>;
	let disposed = false;
	/** Writes out: from the call or keystroke until it answers. */
	let out = 0;
	const listeners = new Set<() => void>();
	const collections = new Map<string, ReturnType<typeof folderCollection>>();

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A folder subscriber failed.', { cause }));
			}
	}

	function set(next: FolderState) {
		state = next;
		notify();
	}

	/** Count `write` in `saving()` until it settles, landed or refused; answers it as it is. */
	function hold<T>(write: Promise<T>): Promise<T> {
		if (out++ === 0) notify();
		return write.finally(() => {
			if (--out === 0) notify();
		});
	}

	/** Open, answering once the attempt settled and its state is set. */
	function start() {
		const opening = open().catch(
			(cause: unknown): Opened => OpenFolderError.StorageUnavailable({ cause }),
		);
		attempt = opening;
		return opening.then((opened) => {
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
		const retry = async () => {
			if (disposed || state.status !== 'failed' || state.retry !== retry)
				return;
			set({ status: 'opening' });
			await start();
		};
		return retry;
	}

	/** The open client for an action, or why there is none; once disposed, `Unavailable` on every build. */
	async function current(): Promise<Current<TContract>> {
		const opened = await attempt;
		if (disposed)
			return ClientError.Unavailable({ cause: 'The folder was closed.' });
		return opened;
	}

	for (const collection of compiled.collections) {
		if (RESERVED.has(collection.name))
			throw new Error(
				`A folder cannot have a collection named ${collection.name}: it is the folder's own.`,
			);
		collections.set(
			collection.name,
			folderCollection(
				collection,
				current as () => Promise<Current<Contract>>,
				hold,
			),
		);
	}
	void start();

	const lifecycle: FolderLifecycle = {
		state: () => state,
		saving: () => out > 0,
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

/** A collection as a folder needs it: its name, its kind, and a note's declared fields. */
type Declared = {
	name: string;
	kind: 'note' | 'file';
	keys: readonly string[];
};

/** An entry as listed: its placeholders, fields and version. */
type Entry = { [key: string]: unknown; version: Version };
type Args = Record<string, unknown>;
/** A file collection's client, and the append its store may have. */
type Files = FileClient<Collection> & {
	append(
		args: Args,
		bytes: Uint8Array,
		options: { create: boolean; announce: boolean },
	): Promise<Result<undefined, Occupied | NotFound | Unavailable>>;
};
/** Either kind of collection client, as this module calls it. */
type Raw = NoteClient<Collection> | Files;
type Answer = Result<unknown, ClientError | OpenFolderError>;

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
 * reads, listed while someone listens, and its writes, each waiting for the
 * open, made over what is shown, and counted by `hold`. `opened()` is told
 * each time an open attempt settles, and `stop()` when the folder is
 * disposed.
 */
function folderCollection(
	declared: Declared,
	current: () => Promise<Current<Contract>>,
	hold: <T>(write: Promise<T>) => Promise<T>,
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

	/** The collection's client once the folder opened, or why there is none. */
	async function raw(): Promise<Result<Raw, OpenFolderError | Unavailable>> {
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

	/** The entry `args` names, as shown. */
	const shown = (args: Args) => items.find((item) => names(item, args));

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
	 * `Conflict`, a `NotFound` or a create's `Occupied`, what refused it.
	 *
	 * A note's refusal answers only once the folder shows what refused it: the
	 * note is read again and shown (or dropped, when nothing is there). When
	 * that read answers `Unavailable`, the folder cannot show it, so the write
	 * answers that `Unavailable` instead of a refusal the caller could not
	 * act on. A note that is there but does not read keeps the refusal. Files
	 * only start a listing, and answer the refusal before it shows.
	 */
	async function settle(
		collection: Raw,
		args: Args,
		written: Answer,
	): Promise<Answer> {
		if (written.error === null) {
			if (written.data === undefined) drop(args);
			else put(written.data as Entry, args);
			return written;
		}
		const { name } = written.error;
		if (name !== 'Conflict' && name !== 'NotFound' && name !== 'Occupied')
			return written;
		if (!('replace' in collection)) {
			if (listeners.size > 0) void reload();
			return written;
		}
		// A create's `args` is the whole value; the note is named by its placeholders.
		const at = name === 'Occupied' ? placeholdersOf(args) : args;
		const now = await collection.get(at as never);
		if (now.error === null) put(now.data as Entry, at);
		else if (now.error.name === 'NotFound') drop(at);
		else if (now.error.name === 'Unavailable') return now;
		return written;
	}

	/** The placeholders of a note's created value: what is not a field or the body. */
	const placeholdersOf = (value: Args): Args =>
		Object.fromEntries(
			Object.entries(value).filter(
				([key]) => key !== 'body' && !declared.keys.includes(key),
			),
		);

	/** What a write is made over: the entry shown (valid or not), or else as read now. */
	async function baseOf(
		collection: Raw,
		args: Args,
	): Promise<Result<Entry, ClientError>> {
		const entry = shown(args) ?? invalid.find((item) => names(item, args));
		if (entry !== undefined) return Ok(entry);
		const listed = await collection.list();
		const found = [
			...(listed.data?.items ?? []),
			...((listed.data && 'invalid' in listed.data
				? listed.data.invalid
				: []) as Entry[]),
		].find((item) => names(item as Entry, args));
		if (found !== undefined) return Ok(found as Entry);
		// Not listed: `get` answers why (`NotFound`, or the listing's own refusal).
		const read = await collection.get(args as never);
		if (read.error !== null) return read;
		return Ok(read.data as Entry);
	}

	/** The version a write passes: `over` when given, else the one shown. */
	async function overOf(
		collection: Raw,
		args: Args,
		over: Version | undefined,
	): Promise<Result<Version, ClientError>> {
		if (over !== undefined) return Ok(over);
		const base = await baseOf(collection, args);
		return base.error === null ? Ok(base.data.version) : base;
	}

	/**
	 * A write to the open collection: `write` once the folder opened, its
	 * answer shown over `args` (the placeholders, or a created value). Not
	 * held: the public method holds it, or the editor's keystroke does.
	 */
	async function writeTo(
		args: Args,
		write: (collection: Raw) => Promise<Answer>,
	): Promise<Answer> {
		const collection = await raw();
		if (collection.error !== null) return collection;
		return settle(collection.data, args, await write(collection.data));
	}

	const writes = {
		create: (value: Args) =>
			writeTo(value, (collection) => collection.create(value as never)),
		update: (args: Args, patch: Args, { base }: { base?: Entry } = {}) =>
			writeTo(args, async (collection) => {
				const from = base ? Ok(base) : await baseOf(collection, args);
				if (from.error !== null) return from;
				if ('replace' in collection)
					return updateNote(collection, args as never, patch as never, {
						base: from.data as never,
					});
				return collection.update(args as never, patch as never, {
					over: from.data.version,
				});
			}),
		replace: (args: Args, text: string, { over }: { over?: Version } = {}) =>
			writeTo(args, async (collection) => {
				if (!('replace' in collection))
					throw new Error('replace is a note collection’s alone');
				const version = await overOf(collection, args, over);
				if (version.error !== null) return version;
				return collection.replace(args as never, text, { over: version.data });
			}),
		delete: (args: Args, { over }: { over?: Version } = {}) =>
			writeTo(args, async (collection) => {
				const version = await overOf(collection, args, over);
				if (version.error !== null) return version;
				return collection.delete(args as never, { over: version.data });
			}),
	};

	const reads = {
		items: () => items,
		loading: () => loading,
		error: () => error,
		get: shown,
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
		async list() {
			const collection = await raw();
			return collection.error === null ? collection.data.list() : collection;
		},
		create: (value: Args) => hold(writes.create(value)),
		update: (args: Args, patch: Args, options?: { base?: Entry }) =>
			hold(writes.update(args, patch, options)),
		delete: (args: Args, options?: { over?: Version }) =>
			hold(writes.delete(args, options)),
	};
	const collection =
		declared.kind === 'note'
			? {
					fieldNames: declared.keys,
					...reads,
					invalid: () => invalid,
					...methods,
					replace: (args: Args, text: string, options?: { over?: Version }) =>
						hold(writes.replace(args, text, options)),
					edit: (args: Args, options: { create?: () => Args } = {}) =>
						editNote({
							args,
							options,
							fieldNames: declared.keys,
							shown: () => shown(args),
							create: writes.create,
							update: writes.update,
							hold,
							subscribe: reads.subscribe,
						}),
				}
			: {
					...reads,
					...methods,
					async read(args: Args) {
						const collection = await raw();
						if (collection.error !== null) return collection;
						return collection.data.get(args as never);
					},
					append: (
						args: Args,
						bytes: Uint8Array,
						options: { create: boolean; announce: boolean },
					) =>
						hold(
							(async () => {
								const collection = await raw();
								if (collection.error !== null) return collection;
								return (collection.data as Files).append(args, bytes, options);
							})(),
						),
				};

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
