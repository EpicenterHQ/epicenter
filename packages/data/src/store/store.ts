import {
	generateBlobId,
	parseBlobId,
	type BlobId,
	type BlobRemote,
	type BlobSource,
	type BlobSources,
	type BlobStore,
	BlobStoreError,
	BlobRemoteError,
} from '@epicenter/blobs';
import {
	type ConformanceIssue,
	compileData,
	type DataDefinition,
	type JsonObject,
	type JsonValue,
	type ParsedDataDefinition,
	type ParsedTable,
} from '@epicenter/data/definition';
import type { SqliteDatabase } from '@epicenter/sqlite';
import type { ScopedSqlite } from '@epicenter/device/owner';
import type {
	Recording,
	RecordingService,
} from '@epicenter/recorder/recording';
import * as Y from '@y/y';
import { customAlphabet } from 'nanoid';
import { defineErrors } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, isErr, isOk, Ok, type Result, trySync } from 'wellcrafted/result';

import {
	createDatabaseDocument,
	createRow,
	deleteRow,
	kvRoot,
	listRowIds,
	type RowInput,
	readRow,
	readRowContent,
	storedTableNames,
	tableRoot,
	updateRow,
} from './document.js';
import {
	attachStoreSync,
	type AttachStoreSyncOptions,
} from '../sync/attach.js';
import { persistOnHide } from './flush-on-hide.js';
import { copyBytes, createSqliteDurablePort, NO_AUTHORITY } from './log.js';
import {
	createPersistenceController,
	type PersistenceController,
	type DurablePort,
	type DurableSnapshot,
} from './persistence.js';

export type {
	ApplyFailedError,
	NonconformingRow,
	RowAbsentError,
} from './errors.js';

// The declaration half of this module lives beside it: `errors.ts` is what a
// store refuses with, `handles.ts` is what an application holds. Re-exported
// here rather than moved out of reach, because `@epicenter/data`'s barrel and
// every caller already name them through this path.
import type {
	SyncConnection,
	SyncConnectionStatus,
} from '../sync/connection.js';
import type {
	ApplyFailedError,
	NonconformingRow,
	RowAbsentError,
} from './errors.js';
import { StoreError, StoreUnusableError } from './errors.js';
import type {
	Data,
	DataDocument,
	DeclaredData,
	DocumentPressure,
	KvHandle,
	Row,
	StoredData,
	SyncCapability,
	TableListener,
	UntypedDeclaredData,
} from './handles.js';

export { StoreError, StoreUnusableError } from './errors.js';
export type {
	Data,
	DatabaseAccount,
	DataDocument,
	DeclaredData,
	DocumentPressure,
	KvHandle,
	ReplicaData,
	ReplicaDocument,
	Row,
	StoredData,
	SyncCapability,
	TableHandle,
	TypedTableHandle,
	UntypedDeclaredData,
} from './handles.js';

/** ADR-0206's minted id: 24 characters, so a collision never happens. */
const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

/** Bytes this process authored, which is what has to reach the authority. */
const localOrigin = Object.freeze({ kind: 'epicenter-local' });

const StoreBackgroundError = defineErrors({
	CloseFailed: ({ cause }: { cause: unknown }) => ({
		message:
			'Store resources could not be fully released after an opening failure.',
		cause,
	}),
	SyncTransportFailed: ({ cause }: { cause: unknown }) => ({
		message: 'A sync dial failed for this replica.',
		cause,
	}),
});

/**
 * One `applyRemote` call, carried on the transaction that applies it.
 *
 * Bytes that arrived from a peer are remote work, not local work. The
 * listener must not append them: `applyRemote` persists what it RECEIVED,
 * when persistence succeeds, never what the document emitted in response.
 * The listener parks the
 * transaction here on its way past, and `applyRemote` delivers from it once
 * the append is enqueued, so the notification still lands after acceptance
 * without anything having to be remembered between two calls.
 *
 * `transaction` stays undefined when the update had missing causal
 * dependencies. Yjs buffers those into `store.pendingStructs`, returns
 * normally, and emits NO event, and delivering nothing is then exactly right:
 * the document did not change.
 */
type RemoteApply = { kind: 'epicenter-remote'; transaction?: Y.Transaction };

function isRemoteApply(origin: unknown): origin is RemoteApply {
	return (origin as RemoteApply | null)?.kind === 'epicenter-remote';
}

/**
 * The client half of sync, which is two facts the store already owns.
 *
 * What this replica authored and has not handed over, and how far through the
 * authority's log it has read. Nothing else: there is no state vector here, and
 * that absence is the design. A state vector cannot express deletion, so it can
 * never answer "have I seen everything", and two of the four withdrawn
 * authority designs died reasoning from one anyway.
 *
 * Both verbs that give ground are safe in one direction only, and both are
 * written to fail in that direction. `acknowledge` runs after the authority has
 * confirmed, and `advance` runs after the bytes have committed, so a crash
 * re-offers or re-applies rather than skipping. Re-delivery is free because an
 * update is idempotent (`evidence/invariants.test.ts`); a skip is invisible
 * forever.
 */
type ClientLog = {
	/**
	 * Merge every unsent update into one, and return it.
	 *
	 * The 30x. Sending one update per transaction is what made the authority's
	 * log look like it had to be compacted; merging on the idle timer an editor
	 * debounces on anyway makes it a rounding error
	 * (`evidence/bench/never-compact.ts`).
	 *
	 * One document, so one merge (ADR-0295). `id` is the highest outbox id the
	 * merged bytes cover, which is what an acknowledgement retires.
	 *
	 * It needs no proof from anybody, and that is the whole reason the merge
	 * lives here rather than on the authority. Every withdrawn design was trying
	 * to let one party rewrite another party's history, which requires proving
	 * the replacement covers what it replaced. A client merging bytes it
	 * indisputably authored has nothing to prove.
	 */
	coalesce(): { id: number; bytes: Uint8Array } | undefined;
	/** The authority has taken responsibility through this entry. */
	acknowledge(throughId: number, authoritySeq: number): void;
	/** How far through the authority's log this replica has read. */
	cursor(): number;
};

/**
 * The delivery machinery only the transport drives (ADR-0238's audit): the
 * client log's bookkeeping, plus the three verbs that move foreign bytes and
 * wake the sender. Reached through `syncEngineOf`, never carried on the
 * public store: no application consumer ever needed these, and every one of
 * them can corrupt a replica if driven casually.
 */
type SyncEngine = ClientLog & {
	/**
	 * Apply bytes from a peer. Never republished as local work.
	 *
	 * The bytes are accepted live immediately; the durable append and the
	 * `advanceTo` bookmark share one append in the persistence queue. A failed
	 * persistence attempt leaves the live document usable and simply causes a
	 * later reconnect to re-deliver the entry.
	 *
	 * The Result's one error is `ApplyFailed`: bytes this document cannot
	 * decode, which is a property of the bytes and leaves the store usable.
	 */
	applyRemote(
		update: Uint8Array,
		opts?: { advanceTo?: number },
	): Result<void, ApplyFailedError>;
	/**
	 * Whether this replica is holding updates it cannot apply yet.
	 *
	 * True means some received update referenced structs that have not arrived,
	 * so the document is missing data it will not report. Yjs surfaces no error
	 * and no event for this, and exposes no public API to detect it, so this
	 * reads an internal field; Yjs's own test helper asserts on the same one.
	 *
	 * A caller must not treat a cursor as settled while this is true, because
	 * advancing past the gap makes the loss permanent.
	 */
	hasUnresolvedDependencies(): boolean;
	/** Durable outbound work became available; never an acceptance-time timer. */
	onSendable(listener: () => void): () => void;

	/**
	 * This replica's whole state as one update: the database document's
	 * complete state (ADR-0295).
	 *
	 * What a snapshot offer carries, and synchronous like every other read of
	 * this document. It was a promise for a shape that no longer exists: it
	 * used to read closed row documents from storage, and ADR-0295 left one
	 * document, already open, already in memory.
	 */
	encodeSnapshot(): Uint8Array;
};

/**
 * The engines, keyed by the sync capability rather than by the store object.
 *
 * Openers wrap the engine's store in frozen spreads (`discard()` on Bun and
 * in the browser), and a spread is a NEW object; the capability rides along
 * by reference, so it is the one key every wrapper preserves.
 */
const syncEngines = new WeakMap<SyncCapability, SyncEngine>();

/**
 * What the connection driving each store reports, if one is attached.
 *
 * Registered against the capability for the same reason the engine is: a
 * wrapper that spreads the store keeps the door reachable. One connection per
 * store, because a second one dialling the same generation would be two
 * writers on one cursor.
 */
const attachedStatus = new WeakMap<
	SyncCapability,
	() => SyncConnectionStatus
>();

/**
 * Hand this store the connection now driving it, and take it back on disposal.
 *
 * Called by `attachStoreSync` and nothing else, which is why it is not on the
 * package's public surface: what leaves the package is a status, not a driver
 * (ADR-0340).
 */
export function registerSyncConnection(
	sync: SyncCapability,
	status: () => SyncConnectionStatus,
): () => void {
	attachedStatus.set(sync, status);
	return () => {
		if (attachedStatus.get(sync) === status) attachedStatus.delete(sync);
	};
}

/**
 * The delivery machinery behind one replica's `sync` capability.
 *
 * Package-internal by convention: exported for the transport and tests, and
 * deliberately absent from the package barrel.
 */
export function syncEngineOf(store: DataDocument): SyncEngine {
	const engine = syncEngines.get(store.sync);
	if (engine === undefined) {
		throw new Error(
			'This store has no sync engine: it is not a replica of any authority.',
		);
	}
	return engine;
}

/** What every store engine needs: the definition and the durable engine. */
export type StoreBacking = {
	durable: DurablePort;
	loaded: DurableSnapshot;
	dispose?: () => void | Promise<void>;
	replication?: Pick<AttachStoreSyncOptions, 'address' | 'transport'>;
};

type StoreEngineOptions<
	TError extends { name: string; message: string } = never,
> = {
	/** Local libraries never create an upload obligation. */
	local?: boolean;
	/**
	 * The one data definition this runtime holds, already parsed
	 * (ADR-0240). Every table handle and the KV handle close over it for the
	 * store's whole life; a newer definition reads the same durable data by
	 * disposing this store and constructing the next one.
	 */
	definition: ParsedDataDefinition;
	/** Local bytes used by owning table fields and the app's blob capabilities. */
	blobStore?: BlobStore;
	/**
	 * Where a subscriber's own failure and a failed durable flush go.
	 *
	 * A listener that throws is contained rather than allowed to abort a
	 * batch, because the commit that produced the batch is already accepted
	 * and one broken listener must not cost every other one its notification;
	 * containing it without reporting it would make a broken subscriber look
	 * like a store that stopped notifying.
	 */
	log?: Logger;
	acquire(): Promise<Result<StoreBacking, TError>>;
};

/** Platform primitives used by the app's blob operations, not another owner. */
export type StoreBlobBacking = {
	local: BlobStore;
	sources: BlobSources;
	remote: BlobRemote | null;
};

export type CreateStoreOptions<TDatabase extends DataDefinition> = {
	/** The application's definition declaration, a `defineData` literal. */
	definition: TDatabase;
	/** The durable record: the update log, the outbox, the cursor, the metadata. */
	sqlite: SqliteDatabase;
	/** Optional local bytes for owning table fields; data-only readers need none. */
	blobStore?: BlobStore;
	dispose?: () => void | Promise<void>;
	log?: Logger;
};

/**
 * Parse a declaration handed to a constructor as a literal.
 *
 * Throwing, not Result-returning, and that is a boundary rather than an
 * accident: at this level the declaration is a `defineData` literal the
 * compiler already validated, so a parse refusal is a programmer error. The
 * openers, which may be handed a declaration that arrived as data, parse
 * first and return the refusal as a boot outcome instead.
 */
function parsedDatabaseOrThrow(
	definition: DataDefinition,
): ParsedDataDefinition {
	const { data, error } = compileData(definition);
	if (error !== null) throw new Error(error.message, { cause: error });
	return data;
}

/** Build the engine options for a synchronous SQLite durable engine. */
function overSqlite<TDatabase extends DataDefinition>({
	definition,
	sqlite,
	dispose,
	...rest
}: CreateStoreOptions<TDatabase>): StoreEngineOptions {
	return {
		definition: parsedDatabaseOrThrow(definition),
		...rest,
		async acquire() {
			try {
				const port = createSqliteDurablePort({ sqlite });
				return Ok({ durable: port, loaded: port.load(), dispose });
			} catch (cause) {
				await dispose?.();
				throw cause;
			}
		},
	};
}

/**
 * Open a store that is one replica of an authority's current document.
 *
 * Every local commit is visible immediately and becomes sendable after
 * persistence succeeds. Its durable outbox entry remains until the authority
 * acknowledges it. The replica verbs (`sync`, `applyRemote`, `onSendable`,
 * `hasUnresolvedDependencies`) always exist, because an account is required
 * and every store is a replica. The durable obligation is one ordered queue:
 * authored bytes and their outbox claim share one row in an atomic flush
 * batch. A wrapper subscribing from outside would commit the obligation in a
 * second batch and break exactly that.
 */
export async function openAccountStore<const TDatabase extends DataDefinition>(
	options: CreateStoreOptions<TDatabase>,
): Promise<Data<TDatabase>> {
	const { store, close, view, ready } = createStoreOverPort(
		overSqlite(options),
	);
	const opened = await ready;
	if (isErr(opened))
		throw new Error(opened.error.message, { cause: opened.error });
	// The symbol is composed back on here and nowhere else. These constructors
	// acquire one thing, so disposing the object frees everything it took, and a
	// test's `await using` is exactly right. A replica acquires three (ADR-0340),
	// which is why its opener hands the closer back separately.
	return Object.freeze({
		...(view as DeclaredData<TDatabase>),
		...store,
		[Symbol.asyncDispose]: close,
	});
}

/**
 * Construct one document's real capabilities and own its backing until close.
 *
 * Acquisition, hydration, and listener installation finish before ready
 * succeeds. Replay never records a new local write. Every runtime follows
 * this same opening path.
 *
 * The parts are internal composition inputs, not a second application handle.
 * An opener assigns view and identity onto store, preserving its persistence
 * getter, and freezes the resulting object. Never spread an opening store:
 * spreading evaluates that getter before the controller exists.
 */
export function createStoreOverPort<
	TError extends { name: string; message: string } = never,
>(options: StoreEngineOptions<TError>) {
	const {
		definition,
		blobStore,
		local = false,
		log = createLogger('data/store'),
	} = options;
	const database = createDatabaseDocument();
	let disposed = false;
	let initialized = false;
	let held: StoreBacking | undefined;
	let connection: SyncConnection | undefined;
	let stopHideFlush: (() => void) | undefined;
	const operations = new Set<Promise<unknown>>();
	const blobSources = new Set<BlobSource>();
	let closeRecording: (() => Promise<void>) | undefined;

	/** Capture shares this document's admission gate and drains before storage. */
	function createRecording(backing: RecordingService): RecordingService {
		const sessions = new Map<BlobId, { raw: Recording; public: Recording }>();
		function hold(raw: Recording): Recording {
			const existing = sessions.get(raw.audioBlobId);
			if (existing) return existing.public;
			const session: Recording = Object.freeze({
				audioBlobId: raw.audioBlobId,
				account: raw.account,
				device: raw.device,
				get endedReason() {
					return raw.endedReason;
				},
				stop: () =>
					runOperation(async () => {
						try {
							return await raw.stop();
						} finally {
							sessions.delete(raw.audioBlobId);
						}
					}),
				cancel: () =>
					runOperation(async () => {
						try {
							return await raw.cancel();
						} finally {
							sessions.delete(raw.audioBlobId);
						}
					}),
				onLevel(handler) {
					assertUsable();
					return raw.onLevel(handler);
				},
				onEnded(handler) {
					assertUsable();
					return raw.onEnded(handler);
				},
			});
			sessions.set(raw.audioBlobId, { raw, public: session });
			return session;
		}
		closeRecording = async () => {
			// Only the acquired dataset owner may adopt capture left by a reload.
			// A refused duplicate opener shares its destination but owns nothing.
			if (sessions.size === 0 && held !== undefined) {
				const current = await backing.current();
				if (current.error && current.error.name !== 'AlreadyRecording')
					throw current.error;
				if (current.data) hold(current.data);
			}
			try {
				await Promise.all(
					[...sessions.values()].map(async ({ raw }) => {
						const result = await raw.cancel();
						if (result.error && result.error.name !== 'NoActiveRecording')
							throw result.error;
					}),
				);
			} finally {
				sessions.clear();
			}
		};
		return Object.freeze({
			current: () =>
				runOperation(async () => {
					const result = await backing.current();
					return result.error
						? result
						: Ok(result.data === null ? null : hold(result.data));
				}),
			start: (params) =>
				runOperation(async () => {
					const result = await backing.start(params);
					return result.error ? result : Ok(hold(result.data));
				}),
			enumerateDevices: () => runOperation(() => backing.enumerateDevices()),
		} satisfies RecordingService);
	}

	function runOperation<T>(operation: () => Promise<T>): Promise<T> {
		assertUsable();
		// Admit before invoking platform code: even a reentrant close must see
		// this operation. Work admitted before close is allowed to finish.
		const pending = Promise.resolve().then(operation);
		operations.add(pending);
		void pending.then(
			() => operations.delete(pending),
			() => operations.delete(pending),
		);
		return pending;
	}

	/** Construct SQL methods admitted and drained by this document. */
	function createSqlite(backing: ScopedSqlite): ScopedSqlite {
		return Object.freeze({
			open: (name) =>
				runOperation(async () => {
					const result = await backing.open(name);
					if (result.error !== null) return result;
					// An opening connection belongs to this document even if close
					// starts before it can be published. Close releases it after drain.
					assertUsable();
					const database: typeof result.data = {
						run: (...args) => runOperation(() => result.data.run(...args)),
						all: (...args) => runOperation(() => result.data.all(...args)),
						batch: (...args) => runOperation(() => result.data.batch(...args)),
					};
					return Ok(Object.freeze(database));
				}),
			delete: (name) => runOperation(() => backing.delete(name)),
		});
	}

	/** Construct actual blob methods under this document's readiness and close. */
	function createBlobs({
		sources,
		remote,
	}: Pick<StoreBlobBacking, 'sources' | 'remote'>) {
		if (blobStore === undefined)
			throw new Error('This document has no blob store.');
		const local = blobStore;
		return Object.freeze({
			remote: Object.freeze({
				upload: (id: BlobId) =>
					runOperation(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.upload(id),
					),
				download: (id: BlobId) =>
					runOperation(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.download(id),
					),
				purge: (id: BlobId) =>
					runOperation(() =>
						remote === null
							? Promise.resolve(BlobRemoteError.RemoteNotConfigured())
							: remote.purge(id),
					),
			}),
			add(blob: Blob) {
				return runOperation(async () => {
					const id = generateBlobId();
					const result = await local.put(id, blob);
					return result.error === null ? Ok(id) : result;
				});
			},
			get: (id: BlobId) => runOperation(() => local.get(id)),
			stat: (id: BlobId) => runOperation(() => local.stat(id)),
			statMany: (ids: readonly BlobId[]) =>
				runOperation(() => local.statMany(ids)),
			open(id: BlobId) {
				return runOperation(async () => {
					const result = await sources.open(id);
					if (result.error !== null) return result;
					const source = result.data;
					if (disposed) {
						source[Symbol.dispose]();
						throw new StoreUnusableError();
					}
					blobSources.add(source);
					return Ok(
						Object.freeze({
							url: source.url,
							[Symbol.dispose]() {
								if (blobSources.delete(source)) source[Symbol.dispose]();
							},
						}),
					);
				});
			},
			removeLocal: (id: BlobId) => runOperation(() => local.delete(id)),
		});
	}

	/**
	 * The local-persistence debt: accepted work the durable engine has not
	 * confirmed (ADR-0238). Every verb enqueues here and returns; a refused
	 * flush retains the work and reports `blocked`, and never fails the verb.
	 */
	let controller: PersistenceController;

	/**
	 * Who is watching each table, keyed by its ROOT, and what it is handed: the
	 * ids `touchedRows` collected for that root since the last delivery.
	 *
	 * By root rather than by name, because a commit arrives as changed types and
	 * a subscriber arrives holding the root its handle was built on: keying by
	 * name meant a second map to translate one into the other, and the name it
	 * produced was never used for anything but the lookup below. `typeListeners`
	 * is keyed the same way, so both keyed signals are now one shape.
	 */
	const tableListeners = new Map<Y.Type, Set<TableListener>>();
	/**
	 * Row ids a table's own delta has named since the last delivery.
	 *
	 * Collected rather than delivered from: `'delta'` fires synchronously
	 * inside acceptance, and a listener that wrote from there would re-enter
	 * the transaction being accepted. It is held here and handed out in
	 * `deliver`, on the same flush every other subscriber hears.
	 *
	 * Only tables somebody subscribes to have an entry, so a commit of two
	 * thousand rows in an application that watches no table still collects
	 * nothing.
	 */
	const touchedRows = new Map<Y.Type, Set<string>>();
	/** How to stop the delta listener filling `touchedRows` for one root. */
	const rowNamers = new Map<Y.Type, () => void>();
	/** Who is watching the one KV root. Beside the tables', for the one reason. */
	const kvListeners = new Set<() => void>();
	/** The one KV root, taken once so a commit can be checked against it. */
	const kvRootType = kvRoot(database);
	/**
	 * Who is watching each row's content node, by the node itself.
	 *
	 * Keyed by the live type rather than by a row and field name, because that
	 * is what a commit names: `changedParentTypes` holds types, and a lookup
	 * beats reconstructing an address for each one.
	 */
	const typeListeners = new Map<Y.Type, Set<() => void>>();
	const committedListeners = new Set<() => void>();

	/**
	 * Tell every listener, and let none of them cost another its notification.
	 *
	 * Copied before iteration, because a listener is allowed to subscribe or
	 * unsubscribe while being told. A throw is contained and logged rather than
	 * propagated: the commit that caused the notification is already accepted,
	 * so a broken subscriber is that subscriber's bug and must not read as a
	 * store that stopped notifying.
	 */
	function notify(listeners: ReadonlySet<() => void> | undefined): void {
		if (listeners === undefined || listeners.size === 0) return;
		for (const listener of [...listeners]) {
			if (disposed) break;
			const { error } = trySync({
				try: listener,
				catch: (cause) => StoreError.SubscriberThrew({ cause }),
			});
			if (error !== null) log.error(error);
		}
	}

	/** The same, for the listeners a table's ids go to. */
	function notifyRows(
		listeners: ReadonlySet<TableListener> | undefined,
		rowIds: readonly string[],
	): void {
		if (listeners === undefined || listeners.size === 0) return;
		for (const listener of [...listeners]) {
			if (disposed) break;
			const { error } = trySync({
				try: () => listener(rowIds),
				catch: (cause) => StoreError.SubscriberThrew({ cause }),
			});
			if (error !== null) log.error(error);
		}
	}

	/**
	 * Subscribe to one table, attaching the thing that names its rows.
	 *
	 * The delta listener is attached with the FIRST subscriber and dropped with
	 * the last, so naming rows is paid for by the tables somebody is watching
	 * and by no others. `evidence/delta-names-the-row.test.ts` pins the
	 * property this rests on: a row is an attribute on the table root, so
	 * `attrs` names it on insert, on a field edit, and on delete.
	 */
	function subscribeTable(root: Y.Type, listener: TableListener): () => void {
		assertUsable();
		let forRoot = tableListeners.get(root);
		if (forRoot === undefined) {
			forRoot = new Set();
			tableListeners.set(root, forRoot);
			const named = new Set<string>();
			touchedRows.set(root, named);
			const onDelta = (delta: unknown): void => {
				const { attrs } = delta as { attrs?: Record<string, unknown> };
				if (attrs === undefined) return;
				for (const rowId of Object.keys(attrs)) named.add(rowId);
			};
			root.on('delta', onDelta);
			rowNamers.set(root, () => root.off('delta', onDelta));
		}
		forRoot.add(listener);
		let stopped = false;
		return () => {
			if (stopped) return;
			stopped = true;
			forRoot.delete(listener);
			if (forRoot.size > 0) return;
			tableListeners.delete(root);
			touchedRows.delete(root);
			rowNamers.get(root)?.();
			rowNamers.delete(root);
		};
	}

	/**
	 * Hand a settled commit to whoever is waiting for it.
	 *
	 * Runs at ACCEPTANCE, whatever the durable engine does later (ADR-0238),
	 * and reads the transaction rather than a buffer. Yjs maintains both maps
	 * for every transaction whether or not anything observes them, so what a
	 * subscriber needs is already assembled by the time `updateV2` fires; the
	 * buffers this replaced existed only to carry the same facts forward from
	 * the type-level `'delta'` events, which fire mid-acceptance and cannot be
	 * delivered from.
	 *
	 * Phase order is a contract: `onCommitted` listeners first, then KV, then
	 * tables, then content nodes, so a follower that marks itself dirty in the
	 * first phase is dirty before any subscriber reads.
	 */
	function deliver(transaction: Y.Transaction): void {
		notify(committedListeners);
		if (transaction.changed.has(kvRootType)) notify(kvListeners);
		// A table's signal means its SHAPE changed, which is two depths and not
		// three (ADR-0187's superset, drawn as tightly as the document allows):
		//
		//   the table root    a row was added or removed
		//   a row             one of its values changed
		//   deeper            a row's content node. NOT a table event.
		//
		// The third line is the whole point. A row's content node is nested on the
		// row (ADR-0295), so before this every keystroke inside a node bubbled to the
		// table root and woke every list in the application. `changed` holds only
		// what a transaction modified DIRECTLY, so the bubble never happens and
		// the depth test is a parent lookup rather than a walk.
		//
		// Skipped outright when nothing is subscribed, which is what the
		// per-table `'delta'` attach used to buy: a commit of 2,000 rows in an
		// application that watches no table should walk nothing and allocate
		// nothing. `subscribe` prunes its own entry so this stays true.
		if (tableListeners.size === 0) return deliverTypes(transaction);
		const roots = new Set<Y.Type>();
		for (const type of transaction.changed.keys()) {
			if (tableListeners.has(type)) {
				roots.add(type);
				continue;
			}
			const parent = type.parent;
			if (parent !== null && tableListeners.has(parent)) roots.add(parent);
		}
		for (const root of roots) {
			const named = touchedRows.get(root);
			const rowIds = named === undefined ? [] : [...named];
			named?.clear();
			notifyRows(tableListeners.get(root), rowIds);
		}
		deliverTypes(transaction);
	}

	/**
	 * The last and finest phase: type-field watchers.
	 *
	 * A type-field subscriber is where an application hangs its own derived
	 * write (ADR-0297), so it runs after every coarser reader has already seen
	 * the commit that caused it.
	 *
	 * `changedParentTypes` rather than `changed`, because this is the one
	 * signal that SHOULD bubble: a watcher on a field wants an edit anywhere
	 * inside it, which is what the type-level `'delta'` it replaced reported.
	 */
	function deliverTypes(transaction: Y.Transaction): void {
		if (typeListeners.size === 0) return;
		for (const type of transaction.changedParentTypes.keys()) {
			notify(typeListeners.get(type));
		}
	}

	function initialize({ durable, loaded, replication }: StoreBacking): void {
		// Hydrate BEFORE the listener exists, so replaying the record cannot append
		// what it just read. Ordering rather than an origin to ignore, and the
		// ordering is backstopped: a replay that reached the listener would carry
		// `transaction.local === false` with no remote origin, and the throw below
		// would fail the open loudly on the first stored update.
		for (const stored of loaded.updates) {
			// Not copied. Both ports hand over arrays that are already this caller's
			// alone, and `applyUpdateV2` reads its input rather than writing to it,
			// so a copy here duplicated the whole document for the length of one
			// call: after a fold the chain is one baseline row, and that row IS the
			// document.
			Y.applyUpdateV2(database, stored, null);
		}
		controller = createPersistenceController({
			port: durable,
			loaded,
			log,
			assertUsable,
		});

		database.on(
			'updateV2',
			(
				update: Uint8Array,
				origin: unknown,
				_document: Y.Doc,
				transaction: Y.Transaction,
			) => {
				if (isRemoteApply(origin)) {
					// `applyRemote` owns both halves for its own bytes. It hears about
					// this transaction through the origin it minted.
					origin.transaction = transaction;
					return;
				}
				// What remains must be a LOCAL transaction, whether a store verb ran
				// it under `localOrigin` or an application wrote through a live type
				// it holds. `applyUpdateV2` forces `transaction.local` to false and a
				// local `transact` defaults it to true, so this check makes the branch
				// below provably an application writing through this document's own
				// types rather than by convention. Decoded foreign bytes reaching it
				// would be persisted as the EMITTED update rather than the received
				// one (nothing at all when causal dependencies are missing; see
				// `applyRemote`), and would join the outbox as this device's authored
				// work and be republished to the authority. The throw surfaces
				// synchronously at the rogue `Y.applyUpdateV2` call site, after
				// mutation. This diagnoses misuse; it cannot roll back borrowed Yjs state.
				if (!transaction.local) {
					throw new Error(
						"Foreign bytes must enter through applyRemote. A direct Y.applyUpdateV2 on this document would be republished as this device's own work, and is lost entirely when its causal dependencies have not arrived.",
					);
				}
				// The delivery runs in a finally, deliberately: the live document
				// already holds the change, so what a subscriber would read is true
				// whatever the durable engine later does with the bytes.
				try {
					controller.append(
						copyBytes(update),
						local ? NO_AUTHORITY : undefined,
					);
				} finally {
					deliver(transaction);
				}
			},
		);
		initialized = true;
		stopHideFlush = persistOnHide(() => controller.persistence.flush());
		if (replication !== undefined) {
			try {
				connection = attachStoreSync({
					store,
					...replication,
					onTransportError: (cause) =>
						log.warn(StoreBackgroundError.SyncTransportFailed({ cause })),
				});
				// A caller-owned transport can synchronously close this store
				// before attach returns the connection close must release.
				if (disposed) connection[Symbol.dispose]();
			} catch (cause) {
				log.warn(StoreBackgroundError.SyncTransportFailed({ cause }));
			}
		}
	}

	/**
	 * The one gate every verb passes: a disposed store throws, it never
	 * returns. Fresh per throw so each call site gets its own stack.
	 */
	function assertUsable(): void {
		if (disposed) throw new StoreUnusableError();
		if (!initialized) throw new Error('The store is not ready.');
	}

	/**
	 * Run direct data operations as one Yjs transaction and one durable batch,
	 * under the origin that marks them as this device's work.
	 *
	 * The one write path: every store verb runs its mutation through here, and
	 * an application groups several of them by calling it itself. There is no
	 * second, ungated form, so the disposal check is on the mutation rather
	 * than on the caller remembering to have made it.
	 *
	 * Everything durable happens in the `updateV2` listener, which fires inside
	 * `transact` after the observers, after `afterTransaction`, and after
	 * cleanup (verified against `@y/y@14.0.0-rc.24`). That is the only moment
	 * the change is settled AND its bytes exist, so it is the only moment both
	 * halves of a commit can be done at once. Acceptance is the synchronous
	 * half and cannot fail for storage reasons; durability is the queued half
	 * (ADR-0238). Await `persistence.flush()` to observe its durable result.
	 *
	 * Nesting needs no bookkeeping here. A `transact` opened inside an open one
	 * reuses the transaction already running and ignores the origin it was
	 * handed, so nested store verbs join the outer one by construction and
	 * `updateV2` fires once, for the outermost. A throw from `run` still leaves
	 * through Yjs's own `finally`, so a partial mutation is queued and
	 * delivered before the error propagates.
	 */
	function transact<TResult>(run: () => TResult): TResult {
		assertUsable();
		return database.transact(run, localOrigin);
	}

	/**
	 * The delivery machinery. Every store has it, because every store has an
	 * authority.
	 */
	const syncEngine: SyncEngine = {
		coalesce() {
			assertUsable();
			return controller.coalesce();
		},
		acknowledge(throughId, authoritySeq) {
			assertUsable();
			controller.acknowledge(throughId, authoritySeq);
		},
		cursor() {
			assertUsable();
			return controller.durableCursor();
		},
		applyRemote(
			update: Uint8Array,
			opts?: { advanceTo?: number },
		): Result<void, ApplyFailedError> {
			assertUsable();
			// One document, so one run of bytes (ADR-0295). The envelope that
			// used to wrap this is gone with the split it multiplexed: there
			// is nothing left to address, so the payload IS the update.
			//
			// The RECEIVED bytes are what gets persisted, never what the
			// document emitted in response to them. Measured against
			// `@y/y@14.0.0-rc.24`: an update whose causal dependencies have
			// not arrived is buffered into `store.pendingStructs`,
			// `applyUpdateV2` returns normally, and the document emits NO
			// `updateV2` event at all. Persisting emitted bytes therefore
			// writes nothing, while the caller advances its cursor and the
			// data is lost permanently with every layer reporting success.
			const received = copyBytes(update);
			// The origin the listener hands this transaction back through.
			// Minted per call, so nothing about one apply has to be
			// remembered beside the store.
			const applying: RemoteApply = { kind: 'epicenter-remote' };
			// A refusal is a property of the bytes: nothing already applied is
			// rolled back (an update is idempotent, so a re-receive after the
			// refusal re-applies harmlessly), the cursor does not advance, and
			// the store stays usable.
			const { error } = trySync({
				try: () => Y.applyUpdateV2(database, received, applying),
				catch: (cause) => StoreError.ApplyFailed({ cause }),
			});
			if (error !== null) return Err(error);
			try {
				// Received bytes carry their bookmark in the same durable row.
				controller.append(received, opts?.advanceTo ?? NO_AUTHORITY);
			} finally {
				// After the enqueue, so every listener phase observes one
				// settled commit. Undefined when the update had missing
				// dependencies: Yjs buffered it and emitted nothing, so the
				// document did not change and there is nothing to deliver.
				if (applying.transaction !== undefined) {
					deliver(applying.transaction);
				}
			}
			return Ok(undefined);
		},
		onSendable(listener: () => void): () => void {
			assertUsable();
			return controller.onSendable(listener);
		},
		hasUnresolvedDependencies() {
			assertUsable();
			return hasPendingStructs(database);
		},
		encodeSnapshot(): Uint8Array {
			assertUsable();
			return new Uint8Array(Y.encodeStateAsUpdateV2(database));
		},
	};

	// The one view this runtime will ever hold, built over the one definition,
	// before hydration. Named roots converge; no rows or defaults are minted.
	const view = buildView();

	const base: Omit<DataDocument, 'sync' | 'definition'> = {
		/**
		 * Everything this application has stored, before its declaration reads
		 * it (ADR-0267).
		 *
		 * The one faithful read, and it is on the data rather than on a table on
		 * purpose. A table handle is the application's lens: `get` and `list`
		 * answer what THIS release can read, and both narrow to the declared
		 * fields, so a key an older release wrote and this one no longer names
		 * is unreachable through them. That narrowing is correct for an
		 * application and correct for any index a follower rebuilds on demand.
		 * It is wrong for an artifact: an export that drops a field is data
		 * loss, and the caller that must not lose one is asking about the store,
		 * not a table.
		 *
		 * So it enumerates the roots the document actually holds rather than the
		 * tables the declaration names, and it hands back stored values untyped.
		 * Untyped is the point: reaching for this means giving up the lens, and
		 * the absent row types are what makes that visible at the call site.
		 *
		 * A row's content node is not here, and cannot be: a nested `Y.Type` is
		 * not a JSON value, so no faithful read of stored VALUES can carry one.
		 * An export reaches it through `content` and the table's own file codec
		 * (ADR-0296).
		 */
		stored(): StoredData {
			assertUsable();
			const tables = new Map<string, ReadonlyMap<string, JsonObject>>();
			for (const tableName of storedTableNames(database)) {
				tables.set(tableName, rowsOf(tableName));
			}
			return { tables, kv: storedKv() };
		},
		/**
		 * One row as the exporter reads it: faithful values and its live content node.
		 *
		 * Deliberately not through a table handle. `readRow` returns every
		 * stored key including ones this release no longer declares, and no
		 * conformance runs, so a row the lens cannot read still has a file
		 * (ADR-0267, ADR-0125). The types come from the declaration's names,
		 * because a type at an undeclared key is unreachable by any codec
		 * anyway.
		 */
		rowFile(tableName: string, rowId: string): Row | undefined {
			assertUsable();
			const root = tableRoot(database, tableName);
			const fields = readRow(root, rowId);
			if (fields === undefined) return undefined;
			const content = readRowContent(root, rowId);
			return {
				id: rowId,
				...fields,
				...(content === undefined ? {} : { content }),
			};
		},
		onCommitted(listener: () => void): () => void {
			assertUsable();
			committedListeners.add(listener);
			return () => committedListeners.delete(listener);
		},
		pressure(): DocumentPressure {
			assertUsable();
			let liveRows = 0;
			// Only declared tables: a document may carry a table this definition
			// does not declare, and guessing at it would report a number
			// nobody could act on.
			for (const tableName of definition.tables.keys()) {
				liveRows += listRowIds(tableRoot(database, tableName)).length;
			}
			const items = structCount(database);
			return {
				items,
				liveRows,
				itemsPerLiveRow: liveRows === 0 ? items : items / liveRows,
			};
		},
		stateVector() {
			assertUsable();
			return new Uint8Array(Y.encodeStateVector(database));
		},
		encodeStateSince(stateVector?: Uint8Array) {
			assertUsable();
			return new Uint8Array(Y.encodeStateAsUpdateV2(database, stateVector));
		},
		// Acceptance, retirement, and state enumeration are the engine's to drive.
		get persistence() {
			assertUsable();
			return controller.persistence;
		},
	};

	/**
	 * End this store, once.
	 *
	 * Beside the store rather than on it, because the party that opened one is
	 * the party that can end one (ADR-0340). One final attempt over whatever is
	 * still queued, then let go: closing never spins on a blocked engine, since
	 * closing while blocked is the accepted loss ADR-0238 makes visible rather
	 * than a reason to hang.
	 */
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		disposed = true;
		if (closing !== undefined) return closing;
		// Publish completion before a disposer can re-enter close. The async
		// body still stops callbacks synchronously, before its first await.
		const completion = Promise.withResolvers<void>();
		closing = completion.promise;
		void (async () => {
			let producersReleased = true;
			try {
				try {
					connection?.[Symbol.dispose]();
				} finally {
					stopHideFlush?.();
				}
			} finally {
				try {
					try {
						const flushing = initialized ? controller.close() : undefined;
						await acquisition;
						await flushing;
					} finally {
						try {
							await Promise.allSettled(operations);
						} finally {
							try {
								await closeRecording?.();
							} catch (cause) {
								producersReleased = false;
								throw cause;
							}
						}
					}
				} finally {
					try {
						const sources = [...blobSources];
						blobSources.clear();
						const released = await Promise.allSettled(
							sources.map(async (source) => source[Symbol.dispose]()),
						);
						const failures = released.filter(
							(result) => result.status === 'rejected',
						);
						if (failures.length) {
							producersReleased = false;
							throw new AggregateError(
								failures.map((failure) => failure.reason),
								'Playback source cleanup failed.',
							);
						}
					} finally {
						try {
							database.destroy();
						} finally {
							// A failed producer release retains the backing and its
							// reservation. A replacement must not race remaining capture.
							if (producersReleased) await held?.dispose?.();
						}
					}
				}
			}
		})().then(completion.resolve, completion.reject);
		return closing;
	};
	// The delivery machinery is registered against the capability rather than
	// the store, so a wrapper that spreads the store (a `discard()` opener)
	// keeps the door reachable.
	const sync: SyncCapability = Object.freeze({
		status() {
			assertUsable();
			return attachedStatus.get(sync)?.();
		},
	});
	if (!local) syncEngines.set(sync, Object.freeze(syncEngine));
	// Composition preserves the real persistence getter instead of evaluating
	// it before acquisition. The opener freezes this object after adding identity.
	const store = Object.assign(base, { sync, definition });
	const acquisition: Promise<Result<StoreBacking, TError | StoreError>> =
		Promise.resolve()
			.then(options.acquire)
			.catch((cause) => StoreError.StorageFailed({ cause }))
			.then((result: Result<StoreBacking, TError | StoreError>) => {
				if (isOk(result)) held = result.data;
				return result;
			});
	const ready: Promise<Result<void, TError | StoreError>> = acquisition.then(
		async (result) => {
			if (isErr(result)) {
				return failOpening(result.error);
			}
			if (disposed) {
				return failOpening(StoreError.ClosedWhileOpening().error);
			}
			try {
				initialize(result.data);
			} catch (cause) {
				return failOpening(StoreError.StorageFailed({ cause }).error);
			}
			if (disposed) return failOpening(StoreError.ClosedWhileOpening().error);
			return Ok(undefined);
		},
	);
	async function failOpening(error: TError | StoreError) {
		// Readiness reports why opening failed. A cleanup failure remains on
		// close's promise and is logged, never substituted for that boot outcome.
		await close().catch((cause) =>
			log.error(StoreBackgroundError.CloseFailed({ cause })),
		);
		return Err(error);
	}
	return {
		// The compiled declaration rides on the store, so nothing downstream
		// compiles it a second time (ADR-0340).
		store,
		createBlobs,
		createSqlite,
		createRecording,
		close,
		ready,
		view,
		definition,
	};

	function buildView(): UntypedDeclaredData {
		const kv = createKvHandle();

		const tables: Record<string, UntypedDeclaredData['tables'][string]> = {};
		for (const [tableName, table] of definition.tables) {
			tables[tableName] = createTableHandle(tableName, table);
		}

		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: UntypedDeclaredData = {
			tables: Object.freeze(tables),
			kv,
			// Beside the writes it groups. Grouping is what an application does,
			// so it belongs on the application's surface rather than on the
			// store's, which is what a transport and an exporter hold.
			transact,
		};
		return Object.freeze(handle);
	}

	/**
	 * The KV handle for this definition's one KV section.
	 *
	 * The root is minted here, which is safe for the same reason KV lives there
	 * at all: `Doc.get` is `setIfUndefined` on `doc.share`, so every device that
	 * mints `kv` converges on one logical root.
	 *
	 * Every definition has a `kv` section, even when it is `{}`. An empty section
	 * has no read lens, so the handle reads and writes the raw structured value
	 * rather than refusing keys that the declaration does not know about.
	 */
	function createKvHandle(): KvHandle {
		const table = definition.kv;
		const root = kvRoot(database);

		/**
		 * The declared keys this release can read, and the ones it cannot.
		 *
		 * Conformance runs over the whole stored object because that is what the
		 * declaration checks, and then the two halves are served separately: one
		 * key that fails costs that key, not the object around it.
		 */
		function readBack(): {
			conforming: JsonObject;
			issues: ConformanceIssue[];
		} {
			return table.conformance(storedKv());
		}

		// Typed where it is WRITTEN, not where it is returned. `Object.freeze(literal)`
		// infers `Readonly<typeof literal>` first, so by the time the result meets
		// the return type it is no longer a FRESH literal and an extra member is
		// not an error. Annotating here is what makes a phantom impossible: one
		// was implemented and unreachable for a release because a cast hid it.
		const handle: KvHandle = {
			get(key: string) {
				assertUsable();
				// One key, checked against one declared field. This used to read
				// every stored key, conform the whole object, and then serve one
				// value out of the result, which made the signature describe work
				// it was not doing: `get(key)` promised a key and cost the object.
				//
				// A key the declaration refused is absent here, exactly as a key
				// nobody ever wrote is, and a key the declaration does not name is
				// absent for a third reason. The caller falls back the same way for
				// all three, which is why they are not told apart.
				//
				// `nonconforming` still conforms the whole object, because that is
				// what it reports: every declared key this release cannot read.
				const field = table.fields.get(key);
				if (field === undefined) return undefined;
				const value = kvRoot(database).getAttr(key as never) as
					| JsonValue
					| undefined;
				if (value === undefined || !field.check(value)) return undefined;
				return value;
			},
			get nonconforming(): ConformanceIssue[] {
				assertUsable();
				return readBack().issues;
			},
			subscribe(listener: () => void): () => void {
				assertUsable();
				kvListeners.add(listener);
				let stopped = false;
				return () => {
					// Idempotent, because a Svelte effect that reruns can call the
					// teardown it was handed more than once.
					if (stopped) return;
					stopped = true;
					kvListeners.delete(listener);
				};
			},
			update(values: JsonObject): void {
				transact(() => {
					for (const [name, value] of Object.entries(values)) {
						root.setAttr(name as never, value as never);
					}
				});
			},
		};
		return Object.freeze(handle);
	}

	/** Every row of one table: by id, unvalidated. */
	function rowsOf(tableName: string): Map<string, JsonObject> {
		const root = tableRoot(database, tableName);
		const rows = new Map<string, JsonObject>();
		for (const rowId of listRowIds(root)) {
			const payload = readRow(root, rowId);
			if (payload !== undefined) rows.set(rowId, payload);
		}
		return rows;
	}

	/** The kv root's stored values, unvalidated. */
	function storedKv(): JsonObject {
		const root = kvRoot(database);
		const values: JsonObject = {};
		for (const key of root.attrKeys()) {
			values[key as string] = root.getAttr(key as never) as JsonValue;
		}
		return values;
	}

	function createTableHandle(
		tableName: string,
		table: ParsedTable,
	): UntypedDeclaredData['tables'][string] {
		const root = tableRoot(database, tableName);
		const blobFields = [...table.fields.values()].filter(
			(field) => field.kind === 'blob',
		);

		/** One stored payload, read through the declaration the way every read reads. */
		function conformRow(
			rowId: string,
			payload: JsonObject,
		): Result<Row, NonconformingRow> {
			const { conforming, issues: fieldIssues } = table.conformance(payload);
			const issues = [...fieldIssues];
			if (readRowContent(root, rowId) === undefined) {
				issues.push({
					field: 'content',
					message: 'content is missing or is not a live Yjs node',
				});
			}
			return issues.length === 0
				? Ok({ id: rowId, ...conforming })
				: Err({
						id: rowId,
						raw: payload,
						// The structural id rides along, so the two branches of the one
						// recovery composition produce the same shape:
						// `data ?? { ...applicationRecovery, ...error.conforming }` is a whole row
						// either way.
						conforming: { id: rowId, ...conforming },
						issues,
					});
		}

		/** One row as an application reads it: the values, and the live node. */
		function withContent(row: Row): Row {
			const content = readRowContent(root, row.id);
			if (content === undefined) {
				throw new Error(
					`row '${row.id}' passed conformance without a live content node`,
				);
			}
			return { ...row, content };
		}

		const handle: UntypedDeclaredData['tables'][string] = {
			create(fields) {
				assertUsable();
				const values: RowInput = {};
				for (const [name, value] of Object.entries(fields)) {
					if (table.fields.get(name)?.kind === 'blob') continue;
					if (value instanceof Blob)
						throw new TypeError(`'${name}' is not a blob field.`);
					values[name] = value;
				}
				if (blobFields.length === 0) {
					const rowId = mintRowId();
					transact(() => createRow(root, rowId, values));
					// Read the integrated content node, never echo its detached input.
					return withContent({ id: rowId, ...readRow(root, rowId) });
				}
				if (blobStore === undefined)
					throw new Error('This document has no blob store.');
				if (database._transaction !== null) {
					throw new Error(
						'Attachment creation cannot run inside a synchronous transaction.',
					);
				}
				const attachments: { name: string; source: Blob | BlobId }[] = [];
				for (const field of blobFields) {
					const value = fields[field.name];
					if (value === null && field.nullable) {
						values[field.name] = null;
						continue;
					}
					const source = value instanceof Blob ? value : parseBlobId(value);
					if (source === undefined)
						throw new TypeError(
							`'${field.name}' requires Blob bytes or a local BlobId to copy.`,
						);
					attachments.push({ name: field.name, source });
				}
				return runOperation(async () => {
					const written: BlobId[] = [];
					const rowId = mintRowId();
					try {
						for (const { name, source } of attachments) {
							assertUsable();
							const id = generateBlobId();
							const result = await (source instanceof Blob
								? blobStore.put(id, source)
								: blobStore.copy(source, id));
							if (result.error !== null) return result;
							written.push(id);
							values[name] = id;
						}
						assertUsable();
						transact(() => {
							createRow(root, rowId, values);
						});
						return Ok(withContent({ id: rowId, ...readRow(root, rowId) }));
					} finally {
						// A transaction can throw after partial mutation. The row, not
						// a second publication flag, says which bytes it accepted.
						const referenced = Object.values(readRow(root, rowId) ?? {});
						const unreferenced = written.filter(
							(id) => !referenced.includes(id),
						);
						const cleanup = await Promise.all(
							unreferenced.map(async (id) => {
								try {
									return await blobStore.delete(id);
								} catch (cause) {
									return BlobStoreError.BlobStoreFailed({ id, cause });
								}
							}),
						);
						for (const result of cleanup) {
							if (result.error !== null) log.error(result.error);
						}
					}
				});
			},
			get(rowId: string): Row | undefined {
				assertUsable();
				const payload = readRow(root, rowId);
				if (payload === undefined) return undefined;
				// A row this declaration cannot read does not arrive. It is not
				// hidden: it is on `nonconforming`, with its raw values, which is
				// where every consumer already looks and where a repair is composed
				// (ADR-0125). Absent and unreadable answer the same way here because
				// a caller asking for one row does the same thing with either.
				const { data } = conformRow(rowId, payload);
				return data === null ? undefined : withContent(data);
			},
			update(rowId: string, fields: JsonObject): Result<void, RowAbsentError> {
				assertUsable();
				for (const field of blobFields) {
					if (Object.hasOwn(fields, field.name))
						throw new TypeError(
							`'${field.name}' is an owning blob field and cannot be patched by ID.`,
						);
				}
				// One lookup, not two. This used to ask `hasRow` and then write
				// through a function that would have minted the row had the answer
				// changed in between; `updateRow` answers whether it found one, so
				// the check and the write are the same read.
				const written = transact(() => updateRow(root, rowId, fields));
				if (!written) return StoreError.RowAbsent({ table: tableName, rowId });
				return Ok(undefined);
			},
			delete(rowId: string): void {
				// One removal (ADR-0295). Taking the row's nested type off the root
				// takes its content node with it, so there is no second address to
				// retire and nothing to compose this write with.
				transact(() => {
					deleteRow(root, rowId);
				});
			},
			ids(): string[] {
				assertUsable();
				return listRowIds(root);
			},
			get rows(): Row[] {
				assertUsable();
				const rows: Row[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { data } = conformRow(rowId, payload);
					if (data !== null) rows.push(withContent(data));
				}
				return rows;
			},
			get nonconforming(): NonconformingRow[] {
				assertUsable();
				const nonconforming: NonconformingRow[] = [];
				for (const [rowId, payload] of rowsOf(tableName)) {
					const { error } = conformRow(rowId, payload);
					if (error !== null) nonconforming.push(error);
				}
				return nonconforming;
			},
			/**
			 * Hear that this table's SHAPE changed: a row added, a row removed, or
			 * a row's values edited. Not an edit inside its content node.
			 *
			 * `deliver` decides WHO hears, by depth against the table root; the
			 * root's own delta decides WHAT they are handed. Both are attached
			 * and dropped with the subscription, so a table nobody watches
			 * registers nothing on the document.
			 */
			subscribe(listener: TableListener): () => void {
				return subscribeTable(root, listener);
			},
			watch(type: Y.Type, listener: () => void): () => void {
				assertUsable();
				// Keyed by the type itself, which is what a commit names:
				// `deliver` reads `changedParentTypes`, so an edit anywhere inside
				// this type reaches the listener while an edit to a sibling does
				// not. `tableName` is not consulted, which is why a type from
				// another table is accepted here (`handles.ts` says why).
				let forType = typeListeners.get(type);
				if (forType === undefined) {
					forType = new Set();
					typeListeners.set(type, forType);
				}
				forType.add(listener);
				let stopped = false;
				return () => {
					// Idempotent, because a Svelte effect that reruns can call the
					// teardown it was handed more than once.
					if (stopped) return;
					stopped = true;
					forType.delete(listener);
					// Pruning the key is not tidiness: `deliver` skips the type
					// phase entirely on `typeListeners.size === 0`, so an entry left
					// behind holding an empty set is a fast path quietly switched
					// off.
					if (forType.size === 0) typeListeners.delete(type);
				};
			},
		};
		return Object.freeze(handle);
	}
}

// What Yjs knows and will not say in one word. Both of these read `doc.store`,
// which is DECLARED and typed in `@y/y`'s shipped types; what is missing is a
// predicate, not the fields. Both have exactly one caller above.

/**
 * Whether a document is holding updates whose dependencies never arrived.
 *
 * Yjs buffers an update it cannot integrate and returns normally, with no
 * error and no event, so `pendingStructs` is the only observable symptom of
 * silent data loss. Its own test helper asserts on this exact field after
 * sync.
 *
 * `store.pendingStructs` and `store.pendingDs` are public, typed
 * `null | {...}` on `StructStore`, so this is a plain read and a rename is a
 * BUILD error rather than a test failure. It used to go through
 * `as unknown as { store?: { pendingStructs?: unknown } }`, which is what made
 * a pinning test necessary: the cast accepted a document with no `store` at
 * all and answered "nothing pending" for it.
 */
function hasPendingStructs(document: Y.Doc): boolean {
	return (
		document.store.pendingStructs !== null || document.store.pendingDs !== null
	);
}

/**
 * Structs the engine is holding.
 *
 * `store.clients` is the same map the memory benches count, and the number is
 * the one memory actually tracks. Public and typed, like the fields above.
 */
function structCount(document: Y.Doc): number {
	let total = 0;
	for (const structs of document.store.clients.values()) {
		total += structs.length;
	}
	return total;
}
