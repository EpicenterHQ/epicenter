/**
 * The browser host of design B's client. A replica is a directory in this
 * origin's private storage (`layout.ts`), and one tab owns it: that tab
 * holds the replica's Web Lock and runs the worker that opens its database,
 * its blob objects and its socket. Its page talks to that worker alone.
 *
 * Another tab opening the same replica finds the lock taken and shows
 * `elsewhere`; its Use here takes the lock (`steal`), which rejects the old
 * tab's lock request: that rejection is how the old tab learns it has
 * `moved`. The old tab closes its worker after the calls it already sent,
 * and never takes the replica back unless the person asks. The new tab's
 * worker shows `waiting` only while an old worker still holds the database;
 * any other failure to open it is `unavailable`, with why.
 *
 * An owning tab also closes its worker when the page is hidden for good or
 * frozen (`pagehide`, `freeze`), so a background tab never holds the
 * storage, and opens it again when the page comes back, if no other tab
 * took it meanwhile. Nothing is resent between tabs: a commit the old worker
 * sent without hearing back is in its database, and the next worker sends
 * it again.
 *
 * Storage is honest about what it is. The first save or seal in a page asks
 * for persistent storage (`navigator.storage.persist()`) from within the
 * caller's gesture, as Firefox requires, and `storagePersistence` shows the
 * grant. `estimateStorage` is the whole origin's usage, not one replica's,
 * and is not the server's quota. A save the device has no room for comes
 * back `QuotaExceeded`, having stored nothing.
 */
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { BlobPut, Put, PutError } from '../../client/bytes.js';
import type { BlobError } from '../../client/bytes.js';
import type { Change, Changed, ChangeError, FileStatus } from '../../client/replica.js';
import type { SqlValue } from '../../sql.js';
import { listReplicas, type Manifest, REPLICA_ID, removeReplicaFiles, replicaLock, type Syncing } from './layout.js';
import type { Collection, Delta, FileEntry, Row, Snapshot } from '../../client/page.js';
import { type Init, SaveError, type TabMessage, type WorkerMessage } from './messages.js';
import type { ReplicaMethods } from './worker.js';

export { listReplicas, type Manifest, type Syncing } from './layout.js';
export { SaveError } from './messages.js';
export type { Collection, Delta, Row, Snapshot } from '../../client/page.js';

export const BrowserReplicaError = defineErrors({
	/** No replica with this id is in this origin, or its removal has begun. */
	NotFound: ({ replica }: { replica: string }) => ({ message: `There is no replica '${replica}' in this browser`, replica }),
	/** The replica could not be opened here, for a reason waiting would not fix. */
	Unavailable: ({ reason }: { reason: string }) => ({ message: `This browser could not open the replica: ${reason}`, reason }),
	/** This origin already holds a replica of the repository for the account. */
	AlreadyHere: ({ replica }: { replica: string }) => ({ message: `This browser already holds this repository for this account, as '${replica}'`, replica }),
	/** Removing would lose text that has not reached the server. */
	UnsentWork: ({ paths }: { paths: string[] }) => ({ message: `${paths.length} file(s) have changes that have not reached the server`, paths }),
	/** The removal stopped before it finished; the next listing finishes it. */
	RemovalUnfinished: ({ cause }: { cause: unknown }) => ({ message: `The removal will finish later: ${extractErrorMessage(cause)}`, cause }),
});
export type BrowserReplicaError = InferErrors<typeof BrowserReplicaError>;

/** Where this tab stands with its replica. */
export type ReplicaTabState =
	| { status: 'opening' }
	/** This tab owns the replica, but another tab's worker has not released the database yet. */
	| { status: 'waiting'; reason: string }
	| { status: 'open'; replica: OpenReplica }
	/** Another tab owns the replica. `useHere` takes it from that tab. */
	| { status: 'elsewhere'; useHere(): void }
	/** Another tab took the replica from this one. It stays there until `useHere`. */
	| { status: 'moved'; useHere(): void }
	| { status: 'unavailable'; error: BrowserReplicaError; retry(): void }
	| { status: 'closed' };

/** What an app's page passes to open a replica. */
export type BrowserReplicaOptions = {
	/** The app's collections: each one's view over the replica's files, its template, and whether a page keeps it in memory. */
	collections?: Collection[];
	/** Sent with the server's HTTP requests, such as `authorization`; the socket gets a ticket with them. */
	headers?: Record<string, string>;
	/** Start the owning tab's worker; by default the package's own worker module. */
	worker?: () => Worker;
	log?: Logger;
};

// ============================================================================
// Storage: persistence and the origin's estimate
// ============================================================================

/** Whether this origin's storage is persistent: not yet known, never asked, or what the browser answered. */
export type Persistence = 'checking' | 'not-asked' | 'granted' | 'denied';

let persistence: Persistence = 'checking';
let asked = false;
const persistenceWatchers = new Set<(persistence: Persistence) => void>();
const setPersistence = (next: Persistence) => {
	persistence = next;
	for (const watcher of persistenceWatchers) watcher(next);
};
let checked = false;
function checkPersistence() {
	if (checked) return;
	checked = true;
	if (typeof navigator.storage?.persisted !== 'function') return setPersistence('denied');
	void navigator.storage.persisted().then(
		(granted) => {
			if (persistence === 'checking') setPersistence(granted ? 'granted' : 'not-asked');
		},
		() => {
			if (persistence === 'checking') setPersistence('not-asked');
		},
	);
}

/**
 * Ask for persistent storage at the first irreplaceable write, synchronously
 * inside the call, so a write made from a click carries the click's user
 * activation (Firefox prompts, and lifts its site-group limit, only then).
 */
function askPersistence() {
	checkPersistence();
	if (asked || persistence === 'granted') return;
	asked = true;
	if (typeof navigator.storage?.persist !== 'function') return setPersistence('denied');
	navigator.storage.persist().then(
		(granted) => setPersistence(granted ? 'granted' : 'denied'),
		() => setPersistence('denied'),
	);
}

/** This origin's persistence grant, now and as it changes. */
export const storagePersistence = {
	get: (): Persistence => {
		checkPersistence();
		return persistence;
	},
	subscribe(onChange: (persistence: Persistence) => void) {
		checkPersistence();
		persistenceWatchers.add(onChange);
		onChange(persistence);
		return () => {
			persistenceWatchers.delete(onChange);
		};
	},
};

/**
 * What the browser says this whole origin uses and may use, in bytes: every
 * replica, app and cache of the origin together, never one replica's share,
 * and nothing to do with the server's limit on a repository.
 */
export async function estimateStorage() {
	const { usage = 0, quota = 0 } = await navigator.storage.estimate();
	return { usage, quota, scope: 'origin' as const };
}

// ============================================================================
// Opening a replica in this tab
// ============================================================================

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };
const deferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const closedError = () => new Error('The replica is not open in this tab');

/** A tab's way to call its worker's `ReplicaMethods`. */
type CallReplica = <TMethod extends keyof ReplicaMethods>(method: TMethod, ...args: Parameters<ReplicaMethods[TMethod]>) => Promise<Awaited<ReturnType<ReplicaMethods[TMethod]>>>;

/** A replica open in this tab, over its session's worker. */
function createOpenReplica({
	manifest,
	call,
	isEnding,
	changes,
	remove,
}: {
	manifest: Manifest;
	call: CallReplica;
	/** Whether the session is closing: a save then comes back `Closed`. */
	isEnding: () => boolean;
	changes: Set<(delta: Delta) => void>;
	/** Close this replica in its tab and delete its files, once its worker has let go. */
	remove: () => Promise<Result<undefined, BrowserReplicaError>>;
}) {
	/** A call whose failures are a save's: a closed tab is `Closed`, not a throw. */
	const save = <T, E>(sent: () => Promise<Result<T, E>>): Promise<Result<T, E | SaveError>> =>
		isEnding() ? Promise.resolve(SaveError.Closed()) : sent().catch(() => SaveError.Closed());
	return {
		/** Which repository this is, its name here, the account and the server. */
		manifest,
		/** What this device shows for a path, or null for no file. */
		read: (path: string) => call('read', path),
		/** Every note of the collections kept in memory, as of one revision. */
		snapshot: (): Promise<Snapshot> => call('snapshot'),
		/** One note as a page reads it, or null. */
		row: (path: string): Promise<Row | null> => call('row', path),
		/** Every path this device shows. */
		paths: () => call('paths'),
		/** Every file this device shows, with its state. */
		files: (): Promise<FileEntry[]> => call('files'),
		/** Every file not yet synced, with its state. */
		waiting: (): Promise<FileEntry[]> => call('waiting'),
		/** One file's state: synced, sending, or held with why. */
		state: (path: string): Promise<FileStatus> => call('state', path),
		/** Files whose text is held back, with why. */
		held: () => call('held'),
		/** One read-only SQL statement over the app's views, or `"epicenter/files"`. */
		query: <TRow = Record<string, SqlValue>>(sql: string, params?: SqlValue[]) => call('query', sql, params) as Promise<TRow[]>,
		/** Whether anything is waiting to send, for an answer, or to be caught up. */
		busy: () => call('busy'),
		/** Paths whose text has not reached the server. */
		unsent: () => call('unsent'),
		/**
		 * Apply changes (create, patch, delete, exact source, a body edit)
		 * over what this device shows now, in one transaction. Resolves once
		 * they are stored, with each path's resulting text and the revision,
		 * or with why nothing was.
		 */
		change(changes: Change[], token?: number): Promise<Result<Changed, ChangeError | SaveError>> {
			askPersistence();
			return save(() => call('change', changes, token));
		},
		/**
		 * Seal each blob into this replica, then store a pointer to it at its
		 * path together with `changes`, in one transaction. A
		 * `Blob` crosses to the worker as a reference: its bytes are read
		 * there, never copied here.
		 */
		put(blobs: BlobPut[], changes: Change[], token?: number): Promise<Result<Put, PutError>> {
			askPersistence();
			return save(() => call('put', blobs, changes, token));
		},
		/** A blob's bytes as a File, which the page reads or shows with its own object URL: from here, or fetched and verified first. */
		open: (path: string): Promise<Result<File, BlobError>> => call('open', path),
		/** Be told each change once it is stored, in revision order: its paths, and the rows now of those kept in memory; returns the function that stops it. */
		watch(listener: (delta: Delta) => void) {
			changes.add(listener);
			return () => {
				changes.delete(listener);
			};
		},
		/**
		 * Remove this replica from this browser: close it, and delete its
		 * database and objects. Refused while text has not reached the server,
		 * unless `discardUnsent`. Recoverable: a removal cut short is finished
		 * by the next `listReplicas`.
		 */
		async remove({ discardUnsent = false }: { discardUnsent?: boolean } = {}): Promise<Result<undefined, BrowserReplicaError>> {
			const unsent = await call('unsent');
			if (unsent.length > 0 && !discardUnsent) return BrowserReplicaError.UnsentWork({ paths: unsent });
			return remove();
		},
	};
}
export type OpenReplica = ReturnType<typeof createOpenReplica>;

/**
 * Make a new replica of `owner`'s `repository` (owner null: yours) in this
 * origin, syncing as `account` with the server at `url` (both null: kept
 * only here), and open it in this tab, with the manifest its worker writes as it
 * first opens it. The origin holds at most one replica per owner,
 * repository and account.
 */
export async function createBrowserReplica(
	given: { owner: string | null; repository: string; name: string } & Syncing & BrowserReplicaOptions,
): Promise<Result<ReplicaTab & { manifest: Manifest }, BrowserReplicaError>> {
	const { owner, repository, name, account, url: _, ...options } = given;
	const existing = (await listReplicas()).find((manifest) => manifest.owner === owner && manifest.repository === repository && manifest.account === account);
	if (existing !== undefined) return BrowserReplicaError.AlreadyHere({ replica: existing.replica });
	const identity = { replica: crypto.randomUUID(), owner, repository, name };
	const manifest: Manifest =
		given.url === null ? { ...identity, account: null, url: null } : { ...identity, account: given.account, url: new URL(given.url.endsWith('/') ? given.url : `${given.url}/`).href };
	return Ok(Object.assign(openTab(manifest.replica, manifest, options), { manifest }));
}

/**
 * The lock requests of tabs this page closed, by replica, until each lets
 * go. A tab this page opens on a replica it is still letting go of waits
 * for it instead of finding the lock taken: the page leaving a repository
 * and coming back to it (Back, or opening it to remove it) is not another
 * tab holding it.
 */
const lettingGo = new Map<string, Promise<unknown>>();

/** Open the replica `replica` of this origin in this tab. */
export function openBrowserReplica({ replica, ...options }: { replica: string } & BrowserReplicaOptions): ReplicaTab {
	return openTab(replica, null, options);
}

function openTab(
	id: string,
	create: Manifest | null,
	{
		collections = [],
		headers = {},
		worker = () => new Worker(new URL('./replica.worker.ts', import.meta.url), { type: 'module' }),
		log = createLogger('repository/browser'),
	}: BrowserReplicaOptions,
) {
	let state: ReplicaTabState = { status: 'opening' };
	const watchers = new Set<(state: ReplicaTabState) => void>();
	const set = (next: ReplicaTabState) => {
		state = next;
		for (const watcher of watchers) watcher(next);
	};
	const unavailable = (error: BrowserReplicaError) => set({ status: 'unavailable', error, retry: () => take('available') });

	/** The worker this tab runs while it owns the replica, and how to end it. */
	type Session = { ended: Promise<void>; end(): void };
	let session: Session | null = null;
	let closed = false;
	/** Whether the page was hidden while owning, so showing it again opens the replica again. */
	let reopen = false;
	/** The latest lock request, which settles once its lock is released. */
	let held: Promise<unknown> = Promise.resolve();
	/** A removal waiting for its session to end, run while this tab still holds the lock. */
	let removal: { session: Session; done: Deferred<Result<undefined, BrowserReplicaError>> } | null = null;

	function startSession(): Session {
		const running = worker();
		let next = 1;
		const calls = new Map<number, Deferred<unknown>>();
		const changes = new Set<(delta: Delta) => void>();
		const ended = deferred<undefined>();
		let ending = false;
		let finished = false;
		const post = (message: TabMessage) => running.postMessage(message);
		/** Whether this session still decides what the tab shows. */
		const current = () => session === me && !ending;

		/** The worker is gone: every call still waiting is answered as closed. */
		function finish() {
			if (finished) return;
			finished = true;
			running.terminate();
			for (const call of calls.values()) call.reject(closedError());
			calls.clear();
			changes.clear();
			ended.resolve(undefined);
		}

		const call: CallReplica = (method, ...args) => {
			if (ending) return Promise.reject(closedError());
			const id = next++;
			const answer = deferred<unknown>();
			calls.set(id, answer);
			post({ type: 'call', id, method, args } as TabMessage);
			return answer.promise as never;
		};
		function remove() {
			const done = deferred<Result<undefined, BrowserReplicaError>>();
			removal = { session: me, done };
			tab.close();
			return done.promise;
		}
		running.onmessage = (event: MessageEvent<WorkerMessage>) => {
			const message = event.data;
			switch (message.type) {
				case 'waiting':
					if (current()) set({ status: 'waiting', reason: message.reason });
					return;
				case 'ready':
					if (current()) set({ status: 'open', replica: createOpenReplica({ manifest: message.manifest, call, isEnding: () => ending, changes, remove }) });
					return;
				case 'missing':
					if (current()) unavailable(BrowserReplicaError.NotFound({ replica: id }).error);
					finish();
					return;
				case 'unavailable':
					if (current()) unavailable(BrowserReplicaError.Unavailable({ reason: message.reason }).error);
					finish();
					return;
				case 'answer':
				case 'failed': {
					const answer = calls.get(message.id);
					calls.delete(message.id);
					if (message.type === 'answer') answer?.resolve(message.value);
					else answer?.reject(new Error(message.reason));
					return;
				}
				case 'changed':
					for (const listener of changes) listener(message.delta);
					return;
				case 'closed':
					finish();
					return;
				default:
					message satisfies never;
			}
		};
		running.addEventListener('error', (event) => {
			const reason = event.message || 'the worker failed to start';
			log.error(BrowserReplicaError.Unavailable({ reason }).error);
			if (current()) unavailable(BrowserReplicaError.Unavailable({ reason }).error);
			finish();
		});
		post({ type: 'init', replica: id, create, collections, headers } satisfies Init);

		const me: Session = {
			ended: ended.promise,
			/** Refuse new calls, let the worker finish the ones already sent, then let it go. */
			end() {
				if (ending) return;
				ending = true;
				if (finished) return;
				post({ type: 'close' });
			},
		};
		return me;
	}

	/** Ask for the lock: only if no tab holds it, or by taking it from the tab that does. */
	function take(how: 'available' | 'steal') {
		if (closed) return;
		set({ status: 'opening' });
		let mine: Session | null = null;
		held = navigator.locks
			.request(replicaLock(id), how === 'steal' ? { steal: true } : { ifAvailable: true }, async (lock) => {
				if (lock === null) {
					set({ status: 'elsewhere', useHere: () => take('steal') });
					return;
				}
				if (closed) return;
				mine = startSession();
				session = mine;
				// Held until this tab closes the replica, hides, or loses it.
				await mine.ended;
				// A removal runs once its worker has let go, while the lock still keeps every other tab out.
				if (removal?.session === mine) {
					const { done } = removal;
					removal = null;
					done.resolve(
						await tryAsync({
							try: async () => {
								await removeReplicaFiles(id);
								return undefined;
							},
							catch: (cause) => BrowserReplicaError.RemovalUnfinished({ cause }),
						}),
					);
				}
			})
			.catch((cause: unknown) => {
				if (mine === null) {
					// The request itself failed; no worker ran.
					unavailable(BrowserReplicaError.Unavailable({ reason: extractErrorMessage(cause) }).error);
					return;
				}
				// Another tab took the replica with Use here. This tab stops, after
				// the calls it already sent, and takes the replica back only when
				// the person asks.
				const lost = mine;
				lost.end();
				if (removal?.session === lost) {
					removal.done.resolve(BrowserReplicaError.RemovalUnfinished({ cause: new Error('another tab took the replica') }));
					removal = null;
				}
				if (session === lost) {
					session = null;
					set({ status: 'moved', useHere: () => take('steal') });
				}
			});
	}

	/** The page is going away or freezing: let the worker finish what was sent and let the storage go. */
	const hide = () => {
		if (session === null) return;
		const hidden = session;
		session = null;
		reopen = true;
		hidden.end();
		set({ status: 'opening' });
	};
	/** The page is back: open the replica again once the old worker has let it go. */
	const show = () => {
		if (!reopen) return;
		reopen = false;
		void held.finally(() => take('available'));
	};
	addEventListener('pagehide', hide);
	addEventListener('pageshow', show);
	document.addEventListener('freeze', hide);
	document.addEventListener('resume', show);

	const tab = {
		/** The replica's id in this origin. */
		replica: id,
		state: () => state,
		/** Be called with the current state and then with every change; returns the function that stops it. */
		subscribe(onChange: (state: ReplicaTabState) => void) {
			watchers.add(onChange);
			onChange(state);
			return () => {
				watchers.delete(onChange);
			};
		},
		/** Close the replica in this tab and give the lock up. */
		close() {
			if (closed) return;
			closed = true;
			removeEventListener('pagehide', hide);
			removeEventListener('pageshow', show);
			document.removeEventListener('freeze', hide);
			document.removeEventListener('resume', show);
			session?.end();
			session = null;
			set({ status: 'closed' });
			watchers.clear();
			const released = held;
			lettingGo.set(id, released);
			void released.finally(() => {
				if (lettingGo.get(id) === released) lettingGo.delete(id);
			});
		},
	};
	const before = lettingGo.get(id);
	if (!REPLICA_ID.test(id)) unavailable(BrowserReplicaError.NotFound({ replica: id }).error);
	else if (before === undefined) take('available');
	else void before.finally(() => take('available'));
	return tab;
}

/** One tab's hold on a replica. */
export type ReplicaTab = ReturnType<typeof openTab>;
