/**
 * The folder `openFolder(contract, place)` returns, on every build (ADR-0766,
 * ADR-0767, ADR-0773, ADR-0774, ADR-0775): handed over at once, already
 * opening, with its state as synchronous reads and its collections directly
 * on it (`folder.todos`).
 *
 * - `state()` is where the folder is in its life: `opening`, `open`,
 *   `failed` with the open's error and the `retry()` for after the person
 *   acted, or `closed` after dispose. It is the same object until it
 *   changes. A temporary failure to open is tried again on its own; only
 *   what waiting will not fix fails.
 * - `unavailable()` is why the store cannot be reached or written now, else
 *   null: while opening the folder keeps trying, and while open what it
 *   shows may be old and writes wait. Always null once failed or closed.
 * - `saving()` is whether a write is out: made and not yet landed, waiting
 *   for the store or its turn.
 * - A collection's reads answer at every moment: `items()` is empty and
 *   `loading()` true until the first listing, and `get(args)` is the entry
 *   shown.
 * - A write (`set`, `delete`, an editor's save) answers once it has landed,
 *   and never fails. The folder keeps every write, in the order made, and
 *   while one cannot land it waits and tries again; a write made while the
 *   folder opens waits for the open. When the folder fails or closes, the
 *   writes waiting then are not made, and their promises never answer.
 * - A write reads the file just before writing it and writes over exactly
 *   what it read; when the file moved in between, it reads and applies the
 *   change again (`note-codec.ts` says how a note's change settles).
 *
 * Only an interface reads `state()` (`<WhenOpen>` from `@epicenter/svelte`);
 * everything else reads and acts. Nothing here knows a framework:
 * `reactive(folder)` from `@epicenter/svelte/reactive` tracks the reads as
 * they are.
 */
import {
	ClientError,
	type Collection,
	type CompiledCollection,
	type Contract,
	compileContract,
	type FileEntryOf,
	type FileOf,
	type InvalidNoteOf,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
} from '@epicenter/definition/contract';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CollectionFiles,
	createDeviceClient,
	type DeviceClient,
	type Entry,
	type Seen,
} from './device/client.js';
import type { DeviceStore, Unavailable } from './device/store.js';
import { OpenFolderError, type RevealRootError } from './errors.js';
import { noteCodec } from './note-codec.js';
import { editNote, type NoteEdit, type NoteEditOptions } from './note-edit.js';

export type { Unavailable } from './device/store.js';
export { OpenFolderError } from './errors.js';
export type { NoteEdit, NoteEditOptions } from './note-edit.js';

/** Why the folder's place could not be shown. */
export type RevealFolderError = RevealRootError;

const log = createLogger('folder');

/**
 * Where the folder is in its life. Retrying belongs to a failure, so only
 * the failed state carries `retry()`. Whether the store can be reached now
 * is `unavailable()`, beside it.
 */
export type FolderState =
	| { readonly status: 'opening' }
	| { readonly status: 'open' }
	| {
			readonly status: 'failed';
			readonly error: OpenFolderError;
			/**
			 * Open again, once the person has acted, answering once that attempt
			 * settles; does nothing, and answers at once, when the folder moved on.
			 */
			retry(): Promise<void>;
	  }
	| { readonly status: 'closed' };

/**
 * The reads every collection of a folder answers at once, and the one way
 * to hear them change. While something listens, the collection is listed,
 * and listed again after every change to its files.
 */
type Reads<TItem> = {
	/** The entries as last listed, and written here since; empty until the first listing. */
	items(): readonly TItem[];
	/** True until the first listing lands, which waits for the open; a listing that cannot reach the store is tried again while something listens. */
	loading(): boolean;
	/**
	 * Call `listener` when a read may answer differently; returns the
	 * unsubscribe. The first listener starts listing, the last one's
	 * unsubscribe stops it.
	 */
	subscribe(listener: () => void): () => void;
};

/** Why an action that reads now could not answer. */
type ReadError = Unavailable | OpenFolderError;

/**
 * A note collection of a folder: its reads, and its writes, each answering
 * once it has landed and never failing (ADR-0775).
 */
export type FolderNotes<TCollection extends Collection> = Reads<
	NoteOf<TCollection>
> & {
	/** The fields the contract declares, in its order: an editor's `fields` are these and `body`. */
	fieldNames: readonly string[];
	/** The notes at the collection's paths that do not read, with their text. */
	invalid(): readonly InvalidNoteOf<TCollection>[];
	/** The note `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): NoteOf<TCollection> | undefined;
	/** Every note, read now, and shown. */
	list(): Promise<
		Result<
			{ items: NoteOf<TCollection>[]; invalid: InvalidNoteOf<TCollection>[] },
			ReadError
		>
	>;
	/**
	 * Make the note `args` names have `changes`: the fields named take these
	 * values (`undefined` removes one), the body is replaced when given, and
	 * the rest stay; the note is made when none is there. A body that
	 * changed since the folder showed the note merges with this one by
	 * lines. A value that does not fit the contract is written, and the
	 * note shows in `invalid()`. Throws, before anything is written, for a
	 * name that would leave the collection or a value front matter cannot
	 * hold.
	 */
	set(
		args: PlaceholdersOf<TCollection>,
		changes: NotePatch<TCollection>,
	): Promise<void>;
	/**
	 * Remove the note `args` names. One already gone is gone; one changed
	 * since the folder showed it is kept with that change, as sync keeps it.
	 */
	delete(args: PlaceholdersOf<TCollection>): Promise<void>;
	/**
	 * The note `args` names as an immediate editor (`NoteEdit`): its fields
	 * and body one by one, or its whole text. See `note-edit.ts`.
	 */
	edit(
		args: PlaceholdersOf<TCollection>,
		options?: NoteEditOptions<TCollection>,
	): NoteEdit<TCollection>;
};

/** A file collection of a folder: its reads (entries without bytes), and its writes. */
export type FolderFiles<TCollection extends Collection> = Reads<
	FileEntryOf<TCollection>
> & {
	/** The entry `args` names, as shown. */
	get(args: PlaceholdersOf<TCollection>): FileEntryOf<TCollection> | undefined;
	/** The file `args` names with its bytes, read now: null when nothing is there. */
	read(
		args: PlaceholdersOf<TCollection>,
	): Promise<Result<FileOf<TCollection> | null, ReadError>>;
	/** Every entry, read now, and shown. */
	list(): Promise<Result<{ items: FileEntryOf<TCollection>[] }, ReadError>>;
	/**
	 * Write `bytes` as the file `args` names, over whatever is there: the
	 * later write to a file wins (ADR-0771). Throws, before anything is
	 * written, for a name that would leave the collection.
	 */
	set(args: PlaceholdersOf<TCollection>, bytes: Uint8Array): Promise<void>;
	/** Remove the file. One already gone is gone; one changed since the folder showed it is kept. */
	delete(args: PlaceholdersOf<TCollection>): Promise<void>;
	/**
	 * Add `bytes` to the end of the file `args` names, for a file written
	 * while it is made, such as a recording: true once they landed, false
	 * when the file was not as `create` says (with `create`, a file was
	 * already there; without, the file went). Listeners hear the file when
	 * it is made, and after that only an append with `announce`. Only this
	 * browser's storage appends: anywhere else the answer is `Unavailable`.
	 * It is not queued with the folder's writes, and answers a failure.
	 */
	append(
		args: PlaceholdersOf<TCollection>,
		bytes: Uint8Array,
		options: { create: boolean; announce: boolean },
	): Promise<Result<boolean, ReadError>>;
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
	 * Why the store cannot be reached or written now, else null: while
	 * opening the folder keeps trying, and while open what it shows may be
	 * old and writes wait. It clears on its own; always null once failed or
	 * closed.
	 */
	unavailable(): Unavailable | null;
	/** Whether a write is out: made and not yet landed. A page's leave guard reads it. */
	saving(): boolean;
	/** Call `listener` when `state()`, `unavailable()`, `saving()` or `displayPath()` changes; returns the unsubscribe. */
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
	/**
	 * Close what the folder opened: `state()` is `closed`, the writes waiting
	 * are not made, and a later write throws.
	 */
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
	'unavailable',
	'saving',
	'subscribe',
	'reveal',
	'displayPath',
]);

/**
 * An open of a place's store: the store, a temporary failure the folder
 * tries again on its own (`Unavailable`), or what waiting will not fix.
 */
export type FolderOpen = () => Promise<
	Result<DeviceStore, OpenFolderError | Unavailable>
>;

/** How long after a failure the folder tries again, doubling per failure up to the most. */
const RETRY_FIRST_MS = 500;
const RETRY_MOST_MS = 30_000;
const backoff = (failures: number) =>
	Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MOST_MS);

/** One write in the folder's queue: run until it lands, over the open store. */
type Job = {
	/** Make the write, answering once it landed or why the store could not be reached. */
	run(client: DeviceClient): Promise<Result<void, Unavailable>>;
	resolve(): void;
	reject(cause: unknown): void;
};

/** What a collection is given by its folder. */
type Host = {
	/** The open client, waiting while the folder opens; why there is none once it failed or closed. */
	opened(): Promise<Result<DeviceClient, ReadError>>;
	/** Queue a write at `path`; throws once the folder is disposed. */
	enqueue(path: string, run: Job['run']): Promise<void>;
	/** Whether a write at `path` is queued and not yet run: a later one there is made over its result. */
	queuedAt(path: string): boolean;
	/** Count an append in `saving()` until it settles. */
	hold<T>(work: Promise<T>): Promise<T>;
	/** Say whether the collection's last listing could reach the store. */
	listed(name: string, unavailable: Unavailable | null): void;
};

/**
 * The folder of `contract` over `open`, which is called now, again after a
 * temporary failure, and again on each retry after a failure that waiting
 * will not fix. `reveal` shows the folder's place, where it has one. A
 * contract with a collection named like a lifecycle member throws.
 */
export function createFolder<TContract extends Contract>(
	contract: TContract,
	open: FolderOpen,
	{
		reveal = null,
		displayPath = () => null,
	}: {
		reveal?: FolderLifecycle['reveal'];
		displayPath?: FolderLifecycle['displayPath'];
	} = {},
): Folder<TContract> {
	const { data: compiled, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });

	let phase: 'opening' | 'open' | 'failed' | 'closed' = 'opening';
	let client: DeviceClient | null = null;
	let failure: { error: OpenFolderError; retry(): Promise<void> } | null = null;
	/** Why the store could not be reached: by the open, the writes, and each collection's listing. */
	let opening: Unavailable | null = null;
	let writing: Unavailable | null = null;
	const listing = new Map<string, Unavailable>();
	let state: FolderState = { status: 'opening' };
	let unavailable: Unavailable | null = null;
	/** Bumped by each open attempt, so a superseded one stands down. */
	let attempts = 0;
	const queue: { job: Job; path: string }[] = [];
	let draining = false;
	let appending = 0;
	const listeners = new Set<() => void>();
	/** Waiting for the next change of the folder's state. */
	const waiting = new Set<() => void>();
	const collections = new Map<string, ReturnType<typeof folderCollection>>();

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A folder subscriber failed.', { cause }));
			}
	}

	/** Answers at the next change of the folder's state, or after `ms` when given. */
	function changed(ms?: number) {
		return new Promise<void>((resolve) => {
			const timer = ms === undefined ? undefined : setTimeout(() => done(), ms);
			const done = () => {
				clearTimeout(timer);
				waiting.delete(done);
				resolve();
			};
			waiting.add(done);
		});
	}

	/**
	 * Set `state()` and `unavailable()` from what is known, keeping the state
	 * object while its status and failure are the same.
	 */
	function refresh() {
		const reachable =
			phase === 'opening' || phase === 'open'
				? (opening ?? writing ?? listing.values().next().value ?? null)
				: null;
		const next: FolderState =
			phase === 'failed' && failure !== null
				? { status: 'failed', ...failure }
				: { status: phase === 'failed' ? 'opening' : phase };
		const sameState =
			next.status === state.status &&
			(!('error' in next) || ('error' in state && next.error === state.error));
		if (sameState && reachable === unavailable) return;
		if (!sameState) state = next;
		unavailable = reachable;
		for (const done of [...waiting]) done();
		notify();
	}

	/** Whether open attempt `attempt` should stand down: the folder closed, or a newer attempt began. */
	const superseded = (attempt: number) =>
		phase === 'closed' || attempt !== attempts;

	/** Open, trying again after a temporary failure, until the store opens or the open fails for good. */
	async function start() {
		const attempt = ++attempts;
		for (let failures = 0; ; failures++) {
			if (superseded(attempt)) return;
			const opened = await open().catch((cause: unknown) =>
				OpenFolderError.StorageUnavailable({ cause }),
			);
			if (superseded(attempt)) {
				if (opened.error === null) opened.data.close?.();
				return;
			}
			if (opened.error === null) {
				client = createDeviceClient(contract, opened.data);
				phase = 'open';
				opening = null;
				writing = null;
				listing.clear();
				refresh();
				for (const collection of collections.values()) collection.opened();
				return;
			}
			if (opened.error.name === 'Unavailable') {
				opening = opened.error;
				refresh();
				await changed(backoff(failures));
				continue;
			}
			phase = 'failed';
			opening = null;
			failure = { error: opened.error, retry: retryFailure() };
			drop();
			refresh();
			return;
		}
	}

	/** A failure's retry: it opens again only while that failure is the state. */
	function retryFailure() {
		const retry = async () => {
			if (phase !== 'failed' || failure?.retry !== retry) return;
			phase = 'opening';
			failure = null;
			refresh();
			await start();
		};
		return retry;
	}

	/** The writes waiting are not made: the folder failed or closed. Their promises never answer. */
	function drop() {
		if (queue.length === 0) return;
		queue.length = 0;
		notify();
	}

	/** Run the queued writes in order, each until it lands, waiting while the store is out of reach. */
	async function drain() {
		if (draining) return;
		draining = true;
		try {
			let failures = 0;
			while (queue.length > 0) {
				while (phase === 'opening') await changed();
				const head = queue[0];
				if (phase !== 'open' || client === null || head === undefined) {
					drop();
					return;
				}
				let ran: Result<void, Unavailable>;
				try {
					ran = await head.job.run(client);
				} catch (cause) {
					queue.shift();
					head.job.reject(cause);
					if (queue.length === 0) notify();
					continue;
				}
				if (ran.error !== null) {
					if (phase !== 'open') continue;
					writing = ran.error;
					refresh();
					await changed(backoff(failures++));
					continue;
				}
				failures = 0;
				if (writing !== null) {
					writing = null;
					refresh();
				}
				queue.shift();
				head.job.resolve();
				if (queue.length === 0) notify();
			}
		} finally {
			draining = false;
		}
	}

	const host: Host = {
		async opened() {
			while (phase === 'opening') await changed();
			if (phase === 'open' && client !== null) return Ok(client);
			if (phase === 'failed' && failure !== null) return Err(failure.error);
			return ClientError.Unavailable({ cause: 'The folder was closed.' });
		},
		enqueue(path, run) {
			if (phase === 'closed')
				throw new Error(
					'The folder was disposed: a write made after it has nowhere to land.',
				);
			return new Promise<void>((resolve, reject) => {
				queue.push({ job: { run, resolve, reject }, path });
				if (queue.length === 1) notify();
				void drain();
			});
		},
		queuedAt: (path) => queue.some((queued) => queued.path === path),
		hold(work) {
			if (appending++ === 0 && queue.length === 0) notify();
			return work.finally(() => {
				if (--appending === 0 && queue.length === 0) notify();
			});
		},
		listed(name, unavailable) {
			const was = listing.get(name) ?? null;
			if (was === unavailable) return;
			if (unavailable === null) listing.delete(name);
			else listing.set(name, unavailable);
			refresh();
		},
	};
	for (const collection of compiled.collections) {
		if (RESERVED.has(collection.name))
			throw new Error(
				`A folder cannot have a collection named ${collection.name}: it is the folder's own.`,
			);
		collections.set(collection.name, folderCollection(collection, host));
	}
	void start();

	const lifecycle: FolderLifecycle = {
		state: () => state,
		unavailable: () => unavailable,
		saving: () => queue.length > 0 || appending > 0,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reveal,
		displayPath,
		[Symbol.dispose]() {
			if (phase === 'closed') return;
			phase = 'closed';
			drop();
			refresh();
			listeners.clear();
			for (const collection of collections.values()) collection.stop();
			client?.store.close?.();
			client = null;
		},
	};
	return Object.assign(
		lifecycle,
		Object.fromEntries(
			[...collections].map(([name, { collection }]) => [name, collection]),
		),
	) as Folder<TContract>;
}

type Args = Record<string, string>;

/**
 * The collection `declared` names: its reads, listed while someone listens,
 * and its writes, each queued with the folder's. `opened()` is told when the
 * folder opens, and `stop()` when it is disposed.
 */
function folderCollection(declared: CompiledCollection, host: Host) {
	const { name } = declared;
	const isNote = declared.kind === 'note';
	const codec = noteCodec(declared);
	/** What the folder shows, by path, in listing order. */
	let shown = new Map<string, Seen>();
	let items: readonly Entry[] = [];
	let invalid: readonly Entry[] = [];
	let loading = true;
	const listeners = new Set<() => void>();
	/** The open collection's own change source, while someone listens. */
	let stopSource: (() => void) | undefined;
	let following = false;
	let listingNow = false;
	let again = false;
	/** Listings that failed in a row, and the try after the last one. */
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A collection subscriber failed.', { cause }));
			}
	}

	/** Recompute what `items()` and `invalid()` answer from `shown`, and tell listeners. */
	function shownChanged() {
		const valid: Entry[] = [];
		const unfit: Entry[] = [];
		for (const seen of shown.values()) {
			if (seen.item !== null) valid.push(seen.item);
			else if (seen.invalid !== null) unfit.push(seen.invalid);
		}
		items = valid;
		invalid = unfit;
		notify();
	}

	/** Show what landed at `path`: a file, or nothing. */
	function show(path: string, seen: Seen | null) {
		if (seen === null) {
			if (!shown.delete(path)) return;
		} else shown.set(path, seen);
		shownChanged();
	}

	/** The collection's files once the folder opened, or why there are none. */
	async function files(): Promise<Result<CollectionFiles, ReadError>> {
		const opened = await host.opened();
		if (opened.error !== null) return opened;
		return Ok(opened.data.collections.get(name) as CollectionFiles);
	}

	/** List now, show it, and say whether the store could be reached. */
	async function listNow(): Promise<Result<Seen[], ReadError>> {
		const collection = await files();
		if (collection.error !== null) return collection;
		const listed = await collection.data.list();
		// A listing someone follows is tried again until it lands, so its failure is the folder's to say.
		if (listeners.size > 0 || listed.error === null)
			host.listed(name, listed.error);
		if (listed.error !== null) return listed;
		const same =
			!loading &&
			listed.data.length === shown.size &&
			listed.data.every(
				(seen) => shown.get(seen.path)?.version === seen.version,
			);
		if (same) return listed;
		shown = new Map(listed.data.map((seen) => [seen.path, seen]));
		loading = false;
		shownChanged();
		return listed;
	}

	/** List again, as long as changes keep arriving while a listing runs. */
	async function reload() {
		clearTimeout(retry);
		retry = undefined;
		if (listingNow) {
			again = true;
			return;
		}
		listingNow = true;
		let failed = false;
		try {
			do {
				again = false;
				const listed = await listNow();
				failed = listed.error?.name === 'Unavailable';
			} while (again);
		} finally {
			listingNow = false;
		}
		failures = failed ? failures + 1 : 0;
		if (failed && listeners.size > 0)
			retry = setTimeout(() => void reload(), backoff(failures - 1));
	}

	/** Follow the open collection's changes and list it, once the folder opened and while someone listens. */
	async function follow() {
		if (following || stopSource !== undefined) return;
		following = true;
		const collection = await files();
		following = false;
		if (listeners.size === 0 || stopSource !== undefined) return;
		if (collection.error !== null) return;
		stopSource = collection.data.subscribe(() => void reload());
		void reload();
	}

	function unfollow() {
		stopSource?.();
		stopSource = undefined;
		clearTimeout(retry);
		retry = undefined;
		failures = 0;
		// Nobody follows it now, so nothing tries it again: it no longer speaks for the folder.
		host.listed(name, null);
	}

	/** The path `args` names; throws for one that would leave the collection. */
	function pathOf(args: Args): string {
		const path = declared.pathOf(args);
		if (path.error !== null)
			throw new Error(
				`${JSON.stringify(args)} names no file of ${declared.template.source}: ${path.error.message}`,
			);
		return path.data;
	}

	/** The path `args` names, or null: a read never throws. */
	function pathOrNull(args: Args) {
		const path = declared.pathOf(args);
		return path.error === null ? path.data : null;
	}

	/**
	 * What a write at `path` is made over: the file as shown when it was made,
	 * or, when a write there is already queued, as shown when this one runs
	 * (what that write landed), so the folder never clashes with itself.
	 */
	function baseAt(path: string): () => Seen | undefined {
		const now = shown.get(path);
		return host.queuedAt(path) ? () => shown.get(path) : () => now;
	}

	/**
	 * Queue a write at `path` that turns what is there (`current`, null for
	 * nothing) into the bytes to write, null to remove the file, or `'keep'`
	 * to leave it: made over exactly what was read, and applied again when
	 * the file moved in between. `first` is what the first try is made over
	 * without reading (null: nothing), when the folder knows it; `landed`
	 * hears what the write left at the path.
	 */
	function write(
		path: string,
		next: (current: Seen | null) => Uint8Array | null | 'keep',
		first: () => Seen | null | undefined,
		landed: (seen: Seen | null) => void = () => {},
	) {
		return host.enqueue(path, async (client) => {
			const collection = client.collections.get(name) as CollectionFiles;
			let current: Seen | null | undefined = first();
			/** Whether `current` was read now, not taken from what is shown. */
			let read = false;
			for (;;) {
				if (current === undefined) {
					const now = await collection.read(path);
					if (now.error !== null) return now;
					current = now.data;
					read = true;
				}
				const bytes = next(current);
				if (bytes === 'keep' || (bytes === null && current === null)) {
					// Nothing to change in what is shown: make sure of it in what is there.
					if (!read) {
						current = undefined;
						continue;
					}
					show(path, current);
					landed(current);
					return Ok(undefined);
				}
				const written = await collection.write(
					path,
					bytes,
					current?.version ?? null,
				);
				if (written.error !== null) return written;
				if (written.data !== 'stale') {
					show(path, written.data);
					landed(written.data);
					return Ok(undefined);
				}
				current = undefined;
				read = false;
			}
		});
	}

	/**
	 * Queue a write of the note at `path` whose text `next` makes from the
	 * text there (null for nothing, or for a note that is not UTF-8), first
	 * over the note shown, without reading it.
	 */
	function writeNote(
		path: string,
		next: (text: string | null, exists: boolean) => string | null,
		landed?: (seen: Seen | null) => void,
	) {
		return write(
			path,
			(current) => {
				const text = current?.text ?? null;
				const written = next(text, current !== null);
				return written === null || written === text
					? 'keep'
					: codec.bytes(written);
			},
			() => {
				const seen = shown.get(path);
				return seen === undefined || seen.text === null ? null : seen;
			},
			landed,
		);
	}

	/** Remove the file at `path` unless it changed since `base` was shown. */
	function remove(path: string, base: () => Seen | undefined) {
		return write(
			path,
			(current) => {
				const was = base();
				if (
					current !== null &&
					was !== undefined &&
					current.version !== was.version
				)
					return 'keep';
				return null;
			},
			base,
		);
	}

	const reads = {
		items: () => items,
		loading: () => loading,
		get(args: Args) {
			const path = pathOrNull(args);
			return path === null ? undefined : (shown.get(path)?.item ?? undefined);
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			if (listeners.size === 1) void follow();
			return () => {
				if (!listeners.delete(listener) || listeners.size > 0) return;
				unfollow();
			};
		},
	};

	const collection = isNote
		? {
				fieldNames: declared.keys,
				...reads,
				invalid: () => invalid,
				async list() {
					const listed = await listNow();
					if (listed.error !== null) return listed;
					return Ok({ items: [...items], invalid: [...invalid] });
				},
				set(args: Args, changes: Record<string, unknown>) {
					const path = pathOf(args);
					const change = { ...changes };
					// A value front matter cannot hold throws now, not in the queue.
					codec.set(null, null, change);
					const base = baseAt(path);
					return writeNote(path, (text) =>
						codec.set(text, base()?.text ?? text, change),
					);
				},
				delete(args: Args) {
					const path = pathOf(args);
					return remove(path, baseAt(path));
				},
				edit: (args: Args, options: NoteEditOptions<Collection> = {}) => {
					const path = pathOf(args);
					return editNote({
						fieldNames: declared.keys,
						options,
						codec,
						shown: () => shown.get(path),
						save: (next, landed) => writeNote(path, next, landed),
						subscribe: reads.subscribe,
					});
				},
			}
		: {
				...reads,
				async list() {
					const listed = await listNow();
					if (listed.error !== null) return listed;
					return Ok({ items: [...items] });
				},
				async read(args: Args) {
					const path = pathOrNull(args);
					if (path === null) return Ok(null);
					const collection = await files();
					if (collection.error !== null) return collection;
					const read = await collection.data.read(path);
					if (read.error !== null) return read;
					if (read.data === null) return Ok(null);
					return Ok({ ...read.data.params, bytes: read.data.bytes });
				},
				set(args: Args, bytes: Uint8Array) {
					const path = pathOf(args);
					if (!(bytes instanceof Uint8Array))
						throw new TypeError(
							`A file of ${declared.template.source} is bytes.`,
						);
					// The later write wins: over whatever is there, first over what is shown, without reading.
					return write(
						path,
						() => bytes,
						() => shown.get(path) ?? null,
					);
				},
				delete(args: Args) {
					const path = pathOf(args);
					return remove(path, baseAt(path));
				},
				append(
					args: Args,
					bytes: Uint8Array,
					options: { create: boolean; announce: boolean },
				) {
					const path = pathOf(args);
					return host.hold(
						(async (): Promise<Result<boolean, ReadError>> => {
							const collection = await files();
							if (collection.error !== null) return collection;
							if (collection.data.append === null)
								return ClientError.Unavailable({
									cause:
										'this folder’s storage cannot add to the end of a file',
								});
							const appended = await collection.data.append(
								path,
								bytes,
								options,
							);
							if (appended.error !== null) return appended;
							return Ok(appended.data === 'landed');
						})(),
					);
				},
			};

	return {
		collection,
		/** The folder opened: follow it for whoever listens. */
		opened() {
			if (listeners.size > 0) void follow();
		},
		stop() {
			listeners.clear();
			unfollow();
		},
	};
}
