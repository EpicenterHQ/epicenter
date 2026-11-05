/**
 * The folder `openFolder(contract, place)` returns, on every build (ADR-0766,
 * ADR-0773 to ADR-0779, ADR-0782): handed over at once, already connecting,
 * with its state as synchronous reads and its collections directly on it
 * (`folder.todos`).
 *
 * **The connection.** Opening a place answers its store (`Store`, four
 * verbs). The folder then connects: it starts watching, lists every visible
 * file, reads the text of every note the contract claims in one request,
 * and then reads again, one path at a time, every path heard in between.
 * `state()` is `opening` until that snapshot lands; a listing or
 * read that cannot reach the store is tried again, `unavailable()` saying
 * why.
 *
 * **One replica.** The folder holds every visible file (no segment of its
 * path starts with `.`): the text of every note the contract claims, and
 * the version and size of every other file, an attachment, `AGENTS.md`, or
 * a person's own file alike, never their bytes. Only the contract's notes
 * and files are items: a collection reads its own paths, and any other
 * file is there for sync. A change the store hears re-reads only its
 * paths; `'all'` lists, compares each version with what is held, and reads
 * what differs, so nothing shows empty while it does. Reads and writes of
 * one path run one at a time, in the order they began, so a later read of
 * a path is never older than an earlier one. A note is parsed against the
 * contract when its collection is first read, and again when it changes.
 *
 * **Reads are synchronous once connected.** A collection's `items()`,
 * `invalid()` and `get(args)` answer what the replica holds; before the
 * snapshot landed they throw `FolderNotOpen`: nothing that reads a store
 * renders before `<WhenOpen>`. An action (`list()`, a file's `read()`, any
 * write) waits for the connection.
 *
 * **Writes never fail while the folder lives** (ADR-0775). Every write
 * waits its turn in one queue, in the order made, reads the file just
 * before writing it, writes over exactly what it read, and when the file
 * moved in between, reads and applies its change again (`note-codec.ts`
 * says how a note's change settles). While a write cannot land it waits and
 * tries again. When the folder fails or closes, every write still waiting
 * rejects with `FolderClosed` (ADR-0782).
 *
 * **One replica, read by sync.** `localStoreOf(folder)` is the connected
 * folder as a store (`sync({ local, remote, manifest })`, ADR-0804): its
 * listing answers every visible file from the replica, with the versions
 * it holds, once the paths heard so far are read again, so a sync that
 * finds nothing changed reads no file; a note's read answers its held
 * text, and any other file's is read from the store. Its writes wait their
 * turn in the folder's queue and update the replica as the folder's own
 * do; a hidden path (the manifest) is written, never held or listed.
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
	isHiddenPath,
	type NoteOf,
	type NotePatch,
	type PlaceholdersOf,
} from '@epicenter/definition/contract';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type FileRead,
	type Listed,
	type Store,
	type Unavailable,
	type Version,
	within,
} from './device/store.js';
import {
	FolderClosed,
	FolderNotOpen,
	OpenFolderError,
	type RevealRootError,
} from './errors.js';
import { decodeNote, noteCodec, type Params } from './note-codec.js';
import { editNote, type NoteEdit, type NoteEditOptions } from './note-edit.js';
import { createPathTurns } from './path-turns.js';

export type { Unavailable } from './device/store.js';
export { FolderClosed, FolderNotOpen, OpenFolderError } from './errors.js';
export type { NoteEdit, NoteEditOptions } from './note-edit.js';

/** Why the folder's place could not be shown. */
export type RevealFolderError = RevealRootError;

const log = createLogger('folder');

const encoder = new TextEncoder();

/** Where a folder keeps its store view; a symbol member, so `reactive`'s copy carries it. */
const LOCAL = Symbol('epicenter.folderLocalStore');

/**
 * `folder` (or `reactive`'s copy of it) as a store, for `sync`: its listing
 * and a note's read answer from what the folder holds, and its writes go
 * through the folder's own queue. `close` leaves the folder open; dispose
 * the folder to close it. Throws for anything `createFolder` did not make.
 */
export function localStoreOf(folder: object): Store {
	const view = (folder as { [LOCAL]?: Store })[LOCAL];
	if (view === undefined)
		throw new Error('expected a folder made by openFolder or createFolder');
	return view;
}

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
 * The reads every collection of a folder answers at once, once the folder
 * connected, and the one way to hear them change.
 */
type Reads<TItem> = {
	/** The entries the folder holds. Throws `FolderNotOpen` before it connected. */
	items(): readonly TItem[];
	/** Call `listener` when a read may answer differently; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
};

/** Why an action that reads could not answer: the folder failed, or closed. */
type ReadError = Unavailable | OpenFolderError;

/**
 * A note collection of a folder: its reads, and its writes, each answering
 * once it has landed and never failing while the folder lives (ADR-0775).
 */
export type FolderNotes<TCollection extends Collection> = Reads<
	NoteOf<TCollection>
> & {
	/** The fields the contract declares, in its order: an editor's `fields` are these and `body`. */
	fieldNames: readonly string[];
	/** The notes at the collection's paths that do not read, with their text. Throws `FolderNotOpen` before the folder connected. */
	invalid(): readonly InvalidNoteOf<TCollection>[];
	/** The note `args` names. Throws `FolderNotOpen` before the folder connected. */
	get(args: PlaceholdersOf<TCollection>): NoteOf<TCollection> | undefined;
	/**
	 * Every note, read from the store now, once the folder connected: the
	 * collection is listed again and what changed is read, for code that must
	 * see another writer's change it may not have heard yet.
	 */
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
	 * hold; rejects with `FolderClosed` when the folder fails or closes
	 * before it lands.
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
	/** The entry `args` names. Throws `FolderNotOpen` before the folder connected. */
	get(args: PlaceholdersOf<TCollection>): FileEntryOf<TCollection> | undefined;
	/** The file `args` names with its bytes, read now: null when nothing is there. */
	read(
		args: PlaceholdersOf<TCollection>,
	): Promise<Result<FileOf<TCollection> | null, ReadError>>;
	/** Every entry, listed from the store now, once the folder connected. */
	list(): Promise<Result<{ items: FileEntryOf<TCollection>[] }, ReadError>>;
	/**
	 * Write `bytes` as the file `args` names, over whatever is there: the
	 * later write to a file wins (ADR-0771). Throws, before anything is
	 * written, for a name that would leave the collection.
	 */
	set(args: PlaceholdersOf<TCollection>, bytes: Uint8Array): Promise<void>;
	/** Remove the file. One already gone is gone; one changed since the folder showed it is kept. */
	delete(args: PlaceholdersOf<TCollection>): Promise<void>;
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
	 * Close what the folder opened: `state()` is `closed`, every write still
	 * waiting rejects with `FolderClosed`, and a later write throws.
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
	Result<Store, OpenFolderError | Unavailable>
>;

/** How long after a failure the folder tries again, doubling per failure up to the most. */
const RETRY_FIRST_MS = 500;
const RETRY_MOST_MS = 30_000;
const backoff = (failures: number) =>
	Math.min(RETRY_FIRST_MS * 2 ** failures, RETRY_MOST_MS);

/** What the folder holds of one file: its version and size, and a note's text (null when it is not UTF-8). */
type Held = { version: Version; size: number | null; text?: string | null };

/** An entry as an app reads it: a note's placeholders, fields and body, or a file's placeholders. */
export type Entry = Record<string, unknown>;

/** One file as a collection shows it. */
export type Seen = {
	path: string;
	params: Params;
	version: Version;
	/** A note's text, null when it is not UTF-8; null for any other file. */
	text: string | null;
	/** What `items()` shows: a note that reads, or a file's placeholders; null for a note that does not read. */
	item: Entry | null;
	/** What `invalid()` shows of a note that does not read; null otherwise. */
	invalid: Entry | null;
};

/** What a write found at its path: the version, and a note's text. */
type Current = { version: Version; text: string | null };

/** What a write makes of what is there (null: nothing): bytes, null to remove it, or `'keep'`. */
type Next = (current: Current | null) => Uint8Array | null | 'keep';

/** One write in the folder's queue: run until it lands, over the connected store. */
type Job = {
	path: string;
	/** Make the write, answering once it landed or why the store could not be reached. */
	run(store: Store): Promise<Result<void, Unavailable>>;
	resolve(): void;
	reject(cause: unknown): void;
};

/**
 * Where a collection's files all sit: its template's leading literal
 * segments (`recordings` for `recordings/{id}.md`), the whole path for a
 * collection of one file (`settings.md`), and `''` for one with a
 * placeholder at the root.
 */
function directoryOf(collection: CompiledCollection): string {
	const literal: string[] = [];
	for (const segment of collection.template.segments) {
		if (!('literal' in segment)) break;
		literal.push(segment.literal);
	}
	return literal.join('/');
}

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
	const { data, error } = compileContract(contract);
	if (error !== null) throw new Error(error.message, { cause: error });
	const compiled = data;

	/** Whether the folder holds the file at `path`: every file but a hidden one. */
	const visible = (path: string) => !isHiddenPath(path);
	/** Whether the file at `path` is one the folder holds the text of: a note of a note collection. */
	const isNote = (path: string) =>
		compiled.claim(path)?.collection.kind === 'note';

	let phase: 'opening' | 'open' | 'failed' | 'closed' = 'opening';
	/** Whether a snapshot ever landed: reads answer from then. */
	let connected = false;
	let store: Store | null = null;
	let stopWatch: (() => void) | null = null;
	let failure: { error: OpenFolderError; retry(): Promise<void> } | null = null;
	/** Why the store could not be reached: by the open and connection, the writes, and the reads of what changed. */
	let opening: Unavailable | null = null;
	let writing: Unavailable | null = null;
	let reading: Unavailable | null = null;
	let state: FolderState = { status: 'opening' };
	let unavailable: Unavailable | null = null;
	/** Bumped by each open attempt, so a superseded one stands down. */
	let attempts = 0;
	const queue: Job[] = [];
	let draining = false;
	const listeners = new Set<() => void>();
	/** Waiting for the next change of the folder's state. */
	const waiting = new Set<() => void>();
	const collections = new Map<string, ReturnType<typeof folderCollection>>();

	/** The replica: what the folder holds of every file the contract claims, by path. */
	const held = new Map<string, Held>();
	/** How many times each path's held state was set: a batch read applies only where it is unchanged. */
	const generations = new Map<string, number>();
	/** Each path's reads and writes, one at a time, in the order they began. */
	const lanes = createPathTurns();
	/** Paths heard and not yet read again; `'all'` when the store could not say which. */
	let pending: Set<string> | 'all' = new Set();
	let catchingUp = false;
	/** The catch-up running now, or the last one: a sync's listing waits for it. */
	let caughtUp: Promise<void> = Promise.resolve();
	let catchUpFailures = 0;
	let catchUpTimer: ReturnType<typeof setTimeout> | undefined;

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
				? (opening ?? writing ?? reading ?? null)
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

	/** Set what the folder holds at `path` (null: nothing), and tell its collection. */
	function hold(path: string, file: Held | null) {
		const was = held.get(path);
		generations.set(path, (generations.get(path) ?? 0) + 1);
		if (file === null) {
			if (was === undefined) return;
			held.delete(path);
		} else {
			if (
				was !== undefined &&
				was.version === file.version &&
				was.text === file.text
			)
				return;
			held.set(path, file);
		}
		const name = compiled.claim(path)?.collection.name;
		if (name !== undefined) collections.get(name)?.changed();
	}

	/** What a read or a write at `path` of `bytes` leaves the folder holding. */
	function heldOf(path: string, bytes: Uint8Array, version: Version): Held {
		if (!isNote(path)) return { version, size: bytes.byteLength };
		const text = decodeNote(bytes);
		return {
			version,
			size: bytes.byteLength,
			text: text.error === null ? text.data : null,
		};
	}

	/** Whether open attempt `attempt` should stand down: the folder closed, or a newer attempt began. */
	const superseded = (attempt: number) =>
		phase === 'closed' || attempt !== attempts;

	/**
	 * Hear the paths the store says changed. While connecting they wait for
	 * the snapshot; after, each is read again in its lane.
	 */
	function hear(paths: readonly string[] | 'all') {
		if (phase === 'closed') return;
		if (paths === 'all') pending = 'all';
		else if (pending !== 'all')
			for (const path of paths) if (visible(path)) pending.add(path);
		if (connected) catchUp();
	}

	/**
	 * Take what the store holds below `places` (everything by default) into
	 * the replica: list, compare each version with what is held, and read
	 * the notes that differ, in one request. A path whose held state changed
	 * while the read ran is read again in its lane. Nothing held shows empty
	 * meanwhile.
	 */
	async function snapshot(
		from: Store,
		places: readonly string[] = [''],
	): Promise<Result<void, Unavailable>> {
		const listed = await from.list(places);
		if (listed.error !== null) return listed;
		const shown = listed.data.filter(({ path }) => visible(path));
		const present = new Set(shown.map(({ path }) => path));
		const stale: string[] = [];
		const began = new Map<string, number>();
		for (const { path, version, size } of shown) {
			if (held.get(path)?.version === version) continue;
			if (isNote(path)) {
				stale.push(path);
				began.set(path, generations.get(path) ?? 0);
			} else hold(path, { version, size });
		}
		// A file the listing missed goes, unless a write of the folder's own is out there.
		for (const path of [...held.keys()])
			if (within(path, places) && !present.has(path) && !queuedAt(path))
				hold(path, null);
		if (stale.length === 0) return Ok(undefined);
		const read = await from.read(stale);
		if (read.error !== null) return read;
		const again: string[] = [];
		for (const file of read.data) {
			if ((generations.get(file.path) ?? 0) !== began.get(file.path)) {
				again.push(file.path);
				continue;
			}
			hold(
				file.path,
				'gone' in file ? null : heldOf(file.path, file.bytes, file.version),
			);
		}
		for (const path of again) {
			const reread = await readPath(from, path);
			if (reread.error !== null) return reread;
		}
		return Ok(undefined);
	}

	/** Whether a write at `path` is queued or running. */
	const queuedAt = (path: string) => queue.some((job) => job.path === path);

	/** Read `path` again in its lane, and hold what is there. */
	function readPath(
		from: Store,
		path: string,
	): Promise<Result<void, Unavailable>> {
		return lanes.run(path, async () => {
			const read = await from.read([path]);
			if (read.error !== null) return read;
			const [file] = read.data;
			hold(
				path,
				file === undefined || 'gone' in file
					? null
					: heldOf(path, file.bytes, file.version),
			);
			return Ok(undefined);
		});
	}

	/**
	 * Read again what the store said changed: each path in its lane, or, for
	 * `'all'`, a new snapshot. While the store cannot be reached it tries
	 * again, `unavailable()` saying why.
	 */
	function catchUp() {
		if (catchingUp || store === null) return;
		caughtUp = catchUpRun(store);
	}

	async function catchUpRun(from: Store) {
		catchingUp = true;
		let failed: Unavailable | null = null;
		/** What could not be read this time: tried again after a while, while anything new is read now. */
		let later: Set<string> | 'all' = new Set();
		try {
			while (phase === 'open' && store === from) {
				const work = pending;
				if (work !== 'all' && work.size === 0) break;
				pending = new Set();
				if (work === 'all') {
					const taken = await snapshot(from);
					if (taken.error !== null) {
						failed = taken.error;
						later = 'all';
					}
					continue;
				}
				const answers = await Promise.all(
					[...work].map(async (path) => ({
						path,
						read: await readPath(from, path),
					})),
				);
				for (const { path, read } of answers) {
					if (read.error === null) continue;
					failed = read.error;
					if (later !== 'all') later.add(path);
				}
			}
		} finally {
			catchingUp = false;
		}
		if (phase !== 'open') return;
		if (failed !== null) {
			reading = failed;
			refresh();
			clearTimeout(catchUpTimer);
			catchUpTimer = setTimeout(() => {
				catchUpTimer = undefined;
				const now = pending as Set<string> | 'all';
				if (later === 'all') pending = 'all';
				else if (now !== 'all') for (const path of later) now.add(path);
				catchUp();
			}, backoff(catchUpFailures++));
			return;
		}
		// Nothing failed: what still waits for a retry keeps `unavailable()` set.
		if (catchUpTimer !== undefined) return;
		catchUpFailures = 0;
		if (reading !== null) {
			reading = null;
			refresh();
		}
	}

	/**
	 * Open, and connect to the store: watch, take the snapshot, then read
	 * what was heard meanwhile. A temporary failure is tried again on its
	 * own, until the folder connects or the open fails for good.
	 */
	async function start() {
		const attempt = ++attempts;
		let opened: Store | null = null;
		for (let failures = 0; ; failures++) {
			if (superseded(attempt)) {
				opened?.close();
				return;
			}
			if (opened === null) {
				const answered = await open().catch((cause: unknown) =>
					OpenFolderError.StorageUnavailable({ cause }),
				);
				if (superseded(attempt)) {
					if (answered.error === null) answered.data.close();
					return;
				}
				if (answered.error !== null && answered.error.name !== 'Unavailable') {
					phase = 'failed';
					opening = null;
					failure = { error: answered.error, retry: retryFailure() };
					drop('failed');
					refresh();
					return;
				}
				if (answered.error !== null) {
					opening = answered.error;
					refresh();
					await changed(backoff(failures));
					continue;
				}
				opened = answered.data;
			}
			const connection = await connect(opened, attempt);
			if (connection === 'superseded' || connection.error === null) return;
			opening = connection.error;
			refresh();
			await changed(backoff(failures));
		}
	}

	/** Connect to `to`: hear, take the snapshot, and open; or why the store could not be reached. */
	async function connect(
		to: Store,
		attempt: number,
	): Promise<Result<void, Unavailable> | 'superseded'> {
		pending = new Set();
		const watching = await to.watch(hear);
		if (superseded(attempt)) {
			if (watching.error === null) watching.data();
			to.close();
			return 'superseded';
		}
		if (watching.error !== null) return watching;
		const taken = await snapshot(to);
		if (superseded(attempt)) {
			watching.data();
			to.close();
			return 'superseded';
		}
		if (taken.error !== null) {
			watching.data();
			return taken;
		}
		store = to;
		stopWatch = watching.data;
		connected = true;
		phase = 'open';
		opening = null;
		writing = null;
		reading = null;
		refresh();
		for (const collection of collections.values()) collection.opened();
		catchUp();
		void drain();
		return Ok(undefined);
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

	/** The writes waiting are not made: the folder failed or closed. Each rejects with `FolderClosed`. */
	function drop(status: 'failed' | 'closed') {
		if (queue.length === 0) return;
		for (const job of queue.splice(0)) job.reject(new FolderClosed(status));
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
				if (phase !== 'open' || store === null || head === undefined) return;
				let ran: Result<void, Unavailable>;
				try {
					ran = await head.run(store);
				} catch (cause) {
					if (queue[0] === head) queue.shift();
					head.reject(cause);
					if (queue.length === 0) notify();
					continue;
				}
				// The folder failed or closed while it ran: its promise has answered.
				if (queue[0] !== head) continue;
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
				head.resolve();
				if (queue.length === 0) notify();
			}
		} finally {
			draining = false;
		}
	}

	const host: Host = {
		async connected() {
			while (phase === 'opening') await changed();
			if (phase === 'open' && store !== null) return Ok(store);
			if (phase === 'failed' && failure !== null) return Err(failure.error);
			return ClientError.Unavailable({ cause: 'The folder was closed.' });
		},
		read(what) {
			if (!connected) throw new FolderNotOpen(what);
		},
		async refresh(place) {
			const ready = await host.connected();
			if (ready.error !== null) return ready;
			return snapshot(ready.data, [place]);
		},
		held: (path) => held.get(path),
		params: (path) => compiled.claim(path)?.params ?? {},
		paths(collection) {
			const paths: string[] = [];
			for (const path of held.keys())
				if (compiled.claim(path)?.collection.name === collection)
					paths.push(path);
			return paths.sort();
		},
		enqueue(path, write) {
			if (phase === 'closed')
				throw new Error(
					'The folder was disposed: a write made after it has nowhere to land.',
				);
			if (phase === 'failed') return Promise.reject(new FolderClosed('failed'));
			return new Promise<void>((resolve, reject) => {
				queue.push({
					path,
					run: (to) => lanes.run(path, () => write(to)),
					resolve,
					reject,
				});
				if (queue.length === 1) notify();
				void drain();
			});
		},
		queuedAt,
		landed: hold,
		heldOf,
		readNow(path) {
			return lanes.run(path, async () => {
				if (store === null)
					return ClientError.Unavailable({ cause: 'The folder was closed.' });
				return store.read([path]);
			});
		},
	};
	/** `error` as the store contract's `Unavailable`. */
	const unavailableFrom = (error: ReadError) =>
		error.name === 'Unavailable'
			? error
			: ClientError.Unavailable({ cause: error }).error;

	const view: Store = {
		async list(wanted) {
			const ready = await host.connected();
			if (ready.error !== null) return Err(unavailableFrom(ready.error));
			// What was heard before the listing is read again first.
			await caughtUp;
			const files: Listed[] = [];
			for (const [path, { version, size }] of held)
				if (within(path, wanted)) files.push({ path, version, size });
			return Ok(files);
		},
		async read(paths) {
			const ready = await host.connected();
			if (ready.error !== null) return Err(unavailableFrom(ready.error));
			const answers: FileRead[] = [];
			for (const path of paths) {
				const file = held.get(path);
				if (file?.text != null) {
					answers.push({
						path,
						bytes: encoder.encode(file.text),
						version: file.version,
					});
					continue;
				}
				// An attachment's bytes, or a note not held: the store has them.
				const read = await host.readNow(path);
				if (read.error !== null) return read;
				answers.push(...read.data);
			}
			return Ok(answers);
		},
		async write(path, bytes, over) {
			let outcome: Version | null | 'stale' = 'stale';
			try {
				await host.enqueue(path, async (to) => {
					const written = await to.write(path, bytes, over);
					if (written.error !== null) return written;
					outcome = written.data;
					if (visible(path) && written.data !== 'stale')
						host.landed(
							path,
							bytes === null || written.data === null
								? null
								: host.heldOf(path, bytes, written.data),
						);
					return Ok(undefined);
				});
			} catch (cause) {
				return ClientError.Unavailable({ cause });
			}
			return Ok(outcome);
		},
		async watch(changed) {
			const ready = await host.connected();
			if (ready.error !== null) return Err(unavailableFrom(ready.error));
			return ready.data.watch(changed);
		},
		close() {},
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
		saving: () => queue.length > 0,
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
			drop('closed');
			refresh();
			listeners.clear();
			clearTimeout(catchUpTimer);
			for (const collection of collections.values()) collection.stop();
			stopWatch?.();
			stopWatch = null;
			store?.close();
			store = null;
		},
	};
	Object.defineProperty(lifecycle, LOCAL, { value: view });
	return Object.assign(
		lifecycle,
		Object.fromEntries(
			[...collections].map(([name, { collection }]) => [name, collection]),
		),
	) as Folder<TContract>;
}

/** What a collection is given by its folder. */
type Host = {
	/** The connected store, waiting while the folder opens; why there is none once it failed or closed. */
	connected(): Promise<Result<Store, ReadError>>;
	/** Throw `FolderNotOpen` for a read of `what` before the folder connected. */
	read(what: string): void;
	/** Once connected, take what the store holds at `place` now into what the folder holds. */
	refresh(place: string): Promise<Result<void, ReadError>>;
	/** What the folder holds at `path`. */
	held(path: string): Held | undefined;
	/** The placeholders of the file at `path`. */
	params(path: string): Params;
	/** The paths the folder holds of `collection`, sorted. */
	paths(collection: string): string[];
	/** Queue a write at `path`; throws once the folder is disposed, rejects with `FolderClosed` once it failed. */
	enqueue(
		path: string,
		write: (store: Store) => Promise<Result<void, Unavailable>>,
	): Promise<void>;
	/** Whether a write at `path` is queued and not yet done: a later one there is made over its result. */
	queuedAt(path: string): boolean;
	/** Hold what a write or a read found at `path` (null: nothing). */
	landed(path: string, file: Held | null): void;
	/** What the folder holds of `bytes` read or written at `path`. */
	heldOf(path: string, bytes: Uint8Array, version: Version): Held;
	/** Read `path` now, in its lane. */
	readNow(path: string): ReturnType<Store['read']>;
};

type Args = Record<string, string>;

/**
 * The collection `declared` names: its reads, parsed from what the folder
 * holds when first read and again for each path that changed, and its
 * writes, each queued with the folder's. `changed(path)` is told when what
 * the folder holds at one of its paths changed, `opened()` when the folder
 * connected, and `stop()` when it is disposed.
 */
function folderCollection(declared: CompiledCollection, host: Host) {
	const { name } = declared;
	const isNote = declared.kind === 'note';
	const codec = noteCodec(declared);
	const listeners = new Set<() => void>();
	/** Each path as last parsed. */
	const parsed = new Map<string, Seen>();
	/** Whether a change waits to be told this turn. */
	let telling = false;
	/** Whether a path changed since `items` and `invalid` were made. */
	let stale = true;
	let items: readonly Entry[] = [];
	let invalid: readonly Entry[] = [];

	function notify() {
		for (const listener of [...listeners])
			try {
				listener();
			} catch (cause) {
				log.error(new Error('A collection subscriber failed.', { cause }));
			}
	}

	/** What the collection shows of `file` at `path`. */
	function seenOf(path: string, file: Held): Seen {
		const params = host.params(path);
		if (!isNote)
			return {
				path,
				params,
				version: file.version,
				text: null,
				item: params,
				invalid: null,
			};
		const text = file.text ?? null;
		const decoded =
			text === null ? codec.unreadable() : codec.decode(path, text);
		if (decoded.error !== null)
			return {
				path,
				params,
				version: file.version,
				text,
				item: null,
				invalid: { ...params, path, issues: decoded.error.issues, text },
			};
		return {
			path,
			params,
			version: file.version,
			text,
			// Fields first: a front matter key cannot shadow a placeholder or the body.
			item: { ...decoded.data.fields, ...params, body: decoded.data.body },
			invalid: null,
		};
	}

	/** The note or file at `path` as shown, parsed again when what is held there changed. */
	function shown(path: string): Seen | undefined {
		const file = host.held(path);
		if (file === undefined) {
			parsed.delete(path);
			return undefined;
		}
		const known = parsed.get(path);
		if (
			known !== undefined &&
			known.version === file.version &&
			known.text === (file.text ?? null)
		)
			return known;
		const seen = seenOf(path, file);
		parsed.set(path, seen);
		return seen;
	}

	/** Make `items` and `invalid` from what is held, parsing only what changed. */
	function current() {
		if (!stale) return;
		const valid: Entry[] = [];
		const unfit: Entry[] = [];
		const paths = host.paths(name);
		const present = new Set(paths);
		for (const path of parsed.keys())
			if (!present.has(path)) parsed.delete(path);
		for (const path of paths) {
			const seen = shown(path);
			if (seen === undefined) continue;
			if (seen.item !== null) valid.push(seen.item);
			else if (seen.invalid !== null) unfit.push(seen.invalid);
		}
		stale = false;
		items = valid;
		invalid = unfit;
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

	/** The path `args` names, or null: a read never throws for a name. */
	function pathOrNull(args: Args) {
		const path = declared.pathOf(args);
		return path.error === null ? path.data : null;
	}

	/** What the folder holds at `path` as a write sees it: null for nothing. */
	function currentAt(path: string): Current | null {
		const file = host.held(path);
		return file === undefined
			? null
			: { version: file.version, text: file.text ?? null };
	}

	/**
	 * What a write at `path` is made over: the file as held when it was made,
	 * or, when a write there is already queued, as held when this one runs
	 * (what that write landed), so the folder never clashes with itself.
	 */
	function baseAt(path: string): () => Current | null {
		const now = currentAt(path);
		return host.queuedAt(path) ? () => currentAt(path) : () => now;
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
		next: Next,
		first: () => Current | null | undefined,
		landed: (seen: Seen | null) => void = () => {},
	) {
		return host.enqueue(path, async (store) => {
			let current: Current | null | undefined = first();
			/** Whether `current` was read now, not taken from what is held. */
			let readNow = false;
			for (;;) {
				if (current === undefined) {
					const now = await store.read([path]);
					if (now.error !== null) return now;
					const [file] = now.data;
					if (file === undefined || 'gone' in file) {
						host.landed(path, null);
						current = null;
					} else {
						const there = host.heldOf(path, file.bytes, file.version);
						host.landed(path, there);
						current = { version: file.version, text: there.text ?? null };
					}
					readNow = true;
				}
				const bytes = next(current);
				if (bytes === 'keep' || (bytes === null && current === null)) {
					// Nothing to change in what is held: make sure of it in what is there.
					if (!readNow) {
						current = undefined;
						continue;
					}
					landed(shown(path) ?? null);
					return Ok(undefined);
				}
				const written = await store.write(
					path,
					bytes,
					current?.version ?? 'absent',
				);
				if (written.error !== null) return written;
				if (written.data !== 'stale') {
					host.landed(
						path,
						bytes === null || written.data === null
							? null
							: host.heldOf(path, bytes, written.data),
					);
					landed(shown(path) ?? null);
					return Ok(undefined);
				}
				current = undefined;
				readNow = false;
			}
		});
	}

	/**
	 * Queue a write of the note at `path` whose text `next` makes from the
	 * text there (null for nothing, or for a note that is not UTF-8), first
	 * over the note held, without reading it.
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
				const there = currentAt(path);
				return there === null || there.text === null ? null : there;
			},
			landed,
		);
	}

	/** Remove the file at `path` unless it changed since `base` was held. */
	function remove(path: string, base: () => Current | null) {
		return write(
			path,
			(current) => {
				const was = base();
				if (current !== null && was !== null && current.version !== was.version)
					return 'keep';
				return null;
			},
			base,
		);
	}

	const reads = {
		items() {
			host.read(`${name}.items()`);
			current();
			return items;
		},
		get(args: Args) {
			host.read(`${name}.get()`);
			const path = pathOrNull(args);
			return path === null ? undefined : (shown(path)?.item ?? undefined);
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	/** Wait for the connection, take what the store holds of the collection now, and make what it shows current. */
	async function whenConnected(): Promise<Result<void, ReadError>> {
		const refreshed = await host.refresh(directoryOf(declared));
		if (refreshed.error !== null) return refreshed;
		current();
		return Ok(undefined);
	}

	const collection = isNote
		? {
				fieldNames: declared.keys,
				...reads,
				invalid() {
					host.read(`${name}.invalid()`);
					current();
					return invalid;
				},
				async list() {
					const ready = await whenConnected();
					if (ready.error !== null) return ready;
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
						shown: () => shown(path),
						save: (next, landed) => writeNote(path, next, landed),
						subscribe: reads.subscribe,
					});
				},
			}
		: {
				...reads,
				async list() {
					const ready = await whenConnected();
					if (ready.error !== null) return ready;
					return Ok({ items: [...items] });
				},
				async read(args: Args) {
					const path = pathOrNull(args);
					if (path === null) return Ok(null);
					const connected = await host.connected();
					if (connected.error !== null) return connected;
					const read = await host.readNow(path);
					if (read.error !== null) return read;
					const [file] = read.data;
					if (file === undefined || 'gone' in file) return Ok(null);
					return Ok({ ...host.params(path), bytes: file.bytes });
				},
				set(args: Args, bytes: Uint8Array) {
					const path = pathOf(args);
					if (!(bytes instanceof Uint8Array))
						throw new TypeError(
							`A file of ${declared.template.source} is bytes.`,
						);
					// The later write wins: over whatever is there, first over what is held, without reading.
					return write(
						path,
						() => bytes,
						() => currentAt(path),
					);
				},
				delete(args: Args) {
					const path = pathOf(args);
					return remove(path, baseAt(path));
				},
			};

	return {
		collection,
		/** What the folder holds at one of its paths changed: listeners hear it once per turn. */
		changed() {
			stale = true;
			if (telling) return;
			telling = true;
			queueMicrotask(() => {
				telling = false;
				notify();
			});
		},
		/** The folder connected: whoever listens may read now. */
		opened() {
			notify();
		},
		stop() {
			listeners.clear();
		},
	};
}
