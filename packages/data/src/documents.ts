import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

import { addressKey, type RowAddress } from './protocol/index.js';
import { type ReplicaV1, ReplicaV1Error } from './replica/v1-replica.js';

const COMPACTION_THRESHOLD = 64;
const PUBLISH_CONCURRENCY = 4;
const hydrationOrigin = Object.freeze({ kind: 'epicenter-document-hydration' });

/**
 * Adapt one SQLite operation the drain owns. Every one of them fails for the
 * same reason and reports the same way, which is what keeps the drain's other
 * boundary, the carrier, visibly separate.
 */
function drainStorage<T>(run: () => T): Result<T, ReplicaV1Error> {
	return trySync({
		try: run,
		catch: (cause) =>
			ReplicaV1Error.StorageFailed({ operation: 'document-drain', cause }),
	});
}

/**
 * The one transaction origin that marks an applied update as authority
 * accepted. Only bytes the authority has already committed may carry it: the
 * persist listener stores them durably without minting a new publication
 * obligation. Everything else, whatever its origin value, is locally authored
 * work that must reach the authority (ADR-0174).
 */
export const acceptedDocumentOrigin = Object.freeze({
	kind: 'epicenter-authority-accepted',
});

/**
 * Who authored one appended update. `local` work advances the durable
 * publication revision in the append transaction; `accepted` bytes already
 * carry authority proof and leave no new obligation (ADR-0171/0174).
 */
export type DocumentUpdateSource = 'local' | 'accepted';

/**
 * The durable terminal condition for one document address, or null when the
 * address has none. `too-large` means the authority refused the lineage at
 * its hard resource bound: the document stays locally durable and usable,
 * Epicenter stops publishing it, and the application owns presentation and
 * recovery (ADR-0174).
 */
export type DocumentSyncIssue = { kind: 'too-large' } | null;

/**
 * One publication attempt's outcome from the authority acceptance operation.
 * `accepted` settles the captured revision; `not-live` reports the row's
 * terminal absence and resolves through scalar deletion; `too-large` records
 * the terminal address-scoped issue. Transport and server failures are thrown
 * by the carrier, not encoded here (ADR-0174).
 */
export type DocumentPublishOutcome = 'accepted' | 'not-live' | 'too-large';

/**
 * The one outbound carrier seam: transport the current encoded state of one
 * dirty document to the authority acceptance operation over HTTP. A thrown
 * error means retryable transport or server failure; the drain backs off and
 * a later attempt reconstructs and resends current state. Yjs semantic
 * idempotency owns retry safety (ADR-0171).
 */
export type PublishDocument = (request: {
	address: RowAddress;
	update: Uint8Array;
}) => DocumentPublishOutcome | Promise<DocumentPublishOutcome>;

/** One explicit pull's transport answer for an open document. */
export type DocumentPullResponse =
	| { kind: 'unchanged' }
	| { kind: 'state'; version: string; update: Uint8Array }
	| { kind: 'not-live' };

/**
 * The one inbound transport seam: fetch authority-accepted state newer than
 * `sinceVersion` (an opaque authority version, undefined on the first pull).
 * A thrown error means transport or server failure. Pulling never publishes
 * local work (ADR-0174).
 */
export type PullDocument = (request: {
	address: RowAddress;
	sinceVersion: string | undefined;
}) => DocumentPullResponse | Promise<DocumentPullResponse>;

export const DocumentPullError = defineErrors({
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Document pull failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	NotAttached: () => ({
		message: 'No attached sync session can pull documents',
	}),
	RowNotLive: () => ({
		message: 'The authority reports this row is no longer live',
	}),
});
export type DocumentPullError = InferErrors<typeof DocumentPullError>;

export type DocumentPublicationStatus = {
	revision: number;
	acceptedRevision: number;
	issue: DocumentSyncIssue;
};

type StoredPublication = SqliteRow & {
	revision: number;
	accepted_revision: number;
	sync_issue: string | null;
};

type StoredUpdate = SqliteRow & {
	update_sequence: number;
	update_bytes: Uint8Array | ArrayBuffer;
};

type DocumentEntry = {
	address: RowAddress;
	document: LiveDocument;
	references: number;
	revoked: Error | undefined;
	pulledVersion: string | undefined;
	pulling: Promise<Result<void, DocumentPullError>> | undefined;
	stopPersistence(): void;
};

type UpdateListener = (update: Uint8Array, origin: unknown) => void;

type LiveDocument = Y.Doc & {
	on(name: 'updateV2', listener: UpdateListener): UpdateListener;
	off(name: 'updateV2', listener: UpdateListener): void;
	destroy(): void;
};

export type RowDocumentConnectionTarget = {
	address: RowAddress;
	applyUpdate(update: Uint8Array, origin?: unknown): void;
	encodeStateAsUpdate(): Uint8Array;
	observe(listener: UpdateListener): () => void;
};

const rowDocumentAccess = new WeakMap<
	RowDocument,
	RowDocumentConnectionTarget
>();

export function registerRowDocumentConnectionTarget(
	document: RowDocument,
	target: RowDocumentConnectionTarget,
): void {
	rowDocumentAccess.set(document, target);
}

export type RowDocument = {
	get: Y.Doc['get'];
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	whenDurable(): Promise<void>;
	/**
	 * Explicitly fetch newer authority-accepted state for this open document.
	 * Never publishes local work, never blocks local editing, and is safe to
	 * call repeatedly; overlapping calls share one in-flight pull.
	 *
	 * Two channels, deliberately. An `Err` is a sync outcome the caller can
	 * live with: it leaves the locally durable document open and usable
	 * (ADR-0174). A rejection means this handle can no longer be used at all,
	 * because it was disposed, revoked, or durable storage refused the
	 * accepted state and closed the handle to protect what is already
	 * committed.
	 */
	pull(): Promise<Result<void, DocumentPullError>>;
	/** The durable terminal publication issue for this address, if any. */
	syncIssue(): Promise<DocumentSyncIssue>;
	[Symbol.asyncDispose](): Promise<void>;
};

export function createDocumentRuntime({
	database,
	replica,
	getPullTransport,
	log = createLogger('data/documents'),
}: {
	database: SqliteDatabase;
	replica: ReplicaV1;
	/**
	 * Resolve the currently attached session's pull transport at call time, or
	 * undefined when no session can pull. Owned by the composing runtime so
	 * document handles stay valid across attach and detach.
	 */
	getPullTransport?: () => PullDocument | undefined;
	log?: Logger;
}) {
	const entries = new Map<string, DocumentEntry>();
	const opening = new Map<string, Promise<DocumentEntry>>();
	const publicationDirtyListeners = new Set<() => void>();
	let isDisposed = false;

	/**
	 * Wake the publication-dirty subscribers for a committed local append.
	 *
	 * Contained per listener: this runs inside a `queueMicrotask` with no
	 * caller, so an escaping throw becomes an uncaught exception rather than
	 * anything a call site could own. The subscriber is the sync supervisor's
	 * coalesced document wake, whose own failures belong to the supervisor.
	 */
	function notifyPublicationDirty(): void {
		for (const listener of publicationDirtyListeners) {
			try {
				listener();
			} catch (cause) {
				log.error(ReplicaV1Error.SubscriberThrew({ cause }).error);
			}
		}
	}

	function requireRuntimeOpen(): void {
		if (isDisposed) throw new Error('Epicenter document runtime is disposed');
	}

	function isRowLive(address: RowAddress): boolean {
		const result = replica.readRow(address);
		if (result.error !== null) throw result.error;
		return result.data !== undefined;
	}

	function requireRowLive(address: RowAddress): void {
		if (isRowLive(address)) return;
		throw new Error(
			`Cannot open document for absent row '${address.namespace}/${address.tableName}/${address.rowId}'`,
		);
	}

	function readUpdates(address: RowAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT update_sequence, update_bytes
			 FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?
			 ORDER BY update_sequence`,
			[address.namespace, address.tableName, address.rowId],
		);
	}

	function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
		return value instanceof Uint8Array
			? new Uint8Array(value)
			: new Uint8Array(value.slice(0));
	}

	function readPublication(address: RowAddress): StoredPublication | undefined {
		return database.all<StoredPublication>(
			`SELECT revision, accepted_revision, sync_issue
			 FROM document_publication
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[address.namespace, address.tableName, address.rowId],
		)[0];
	}

	function replay(updates: readonly StoredUpdate[]): LiveDocument {
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		try {
			for (const update of updates) {
				Y.applyUpdateV2(document, copyBytes(update.update_bytes));
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	function append(
		address: RowAddress,
		update: Uint8Array,
		source: DocumentUpdateSource,
	): void {
		database.transaction(() => {
			if (!isRowLive(address)) {
				throw new Error(`Cannot persist document update for absent row '//'`);
			}
			const nextSequence =
				database.all<SqliteRow & { sequence: number }>(
					`SELECT COALESCE(MAX(update_sequence), 0) + 1 AS sequence
					 FROM document_updates
					 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
					[address.namespace, address.tableName, address.rowId],
				)[0]?.sequence ?? 1;
			database.run(
				`INSERT INTO document_updates (
					namespace, table_name, row_id, update_sequence, update_bytes
				) VALUES (?, ?, ?, ?, ?)`,
				[
					address.namespace,
					address.tableName,
					address.rowId,
					nextSequence,
					new Uint8Array(update),
				],
			);
			// Durable bytes and their publication obligation commit together: a
			// crash can never separate locally authored work from the revision
			// that makes the drain republish it (ADR-0171).
			if (source === 'local') {
				database.run(
					`INSERT INTO document_publication (
						namespace, table_name, row_id, revision, accepted_revision
					) VALUES (?, ?, ?, 1, 0)
					ON CONFLICT (namespace, table_name, row_id) DO UPDATE SET
						revision = revision + 1`,
					[address.namespace, address.tableName, address.rowId],
				);
				queueMicrotask(notifyPublicationDirty);
			}
			const updates = readUpdates(address);
			if (updates.length < COMPACTION_THRESHOLD) return;
			const compacted = replay(updates);
			try {
				const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
				database.run(
					'DELETE FROM document_updates WHERE namespace = ? AND table_name = ? AND row_id = ?',
					[address.namespace, address.tableName, address.rowId],
				);
				database.run(
					`INSERT INTO document_updates (
						namespace, table_name, row_id, update_sequence, update_bytes
					) VALUES (?, ?, ?, 1, ?)`,
					[address.namespace, address.tableName, address.rowId, baseline],
				);
			} finally {
				compacted.destroy();
			}
		});
	}

	function createEntry(address: RowAddress): DocumentEntry {
		requireRowLive(address);
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === hydrationOrigin) return;
			try {
				append(
					address,
					update,
					origin === acceptedDocumentOrigin ? 'accepted' : 'local',
				);
			} catch (cause) {
				// Fail closed: the live document now holds work durable storage
				// refused, so the handle is revoked after this transaction rather
				// than silently diverging from SQLite (ADR-0171).
				queueMicrotask(() =>
					revokeWith(
						address,
						new Error(`Row document storage failed for '//'`, { cause }),
					),
				);
				throw cause;
			}
		};
		document.on('updateV2', persist);
		try {
			for (const update of readUpdates(address)) {
				Y.applyUpdateV2(
					document,
					copyBytes(update.update_bytes),
					hydrationOrigin,
				);
			}
			requireRowLive(address);
			const entry: DocumentEntry = {
				address: { ...address },
				document,
				references: 0,
				revoked: undefined,
				pulledVersion: undefined,
				pulling: undefined,
				stopPersistence() {
					document.off('updateV2', persist);
				},
			};
			entries.set(addressKey(address), entry);
			return entry;
		} catch (cause) {
			document.off('updateV2', persist);
			document.destroy();
			throw cause;
		}
	}

	async function entryFor(address: RowAddress): Promise<DocumentEntry> {
		requireRuntimeOpen();
		const cacheKey = addressKey(address);
		const existing = entries.get(cacheKey);
		if (existing !== undefined) return existing;
		const pending = opening.get(cacheKey);
		if (pending !== undefined) return pending;
		const created = Promise.resolve().then(() => createEntry({ ...address }));
		opening.set(cacheKey, created);
		try {
			return await created;
		} finally {
			if (opening.get(cacheKey) === created) opening.delete(cacheKey);
		}
	}

	function destroyEntry(entry: DocumentEntry): void {
		const cacheKey = addressKey(entry.address);
		if (entries.get(cacheKey) === entry) entries.delete(cacheKey);
		entry.stopPersistence();
		entry.document.destroy();
	}

	function isEntryCurrent(entry: DocumentEntry): boolean {
		return (
			!isDisposed &&
			entry.revoked === undefined &&
			entries.get(addressKey(entry.address)) === entry
		);
	}

	function revokeWith(address: RowAddress, error: Error): void {
		const entry = entries.get(addressKey(address));
		if (entry === undefined || entry.revoked !== undefined) return;
		entry.revoked = error;
		destroyEntry(entry);
	}

	function pullEntry(
		entry: DocumentEntry,
	): Promise<Result<void, DocumentPullError>> {
		// Overlapping pulls share one in-flight request; the next call after
		// completion issues a fresh one. Repeated application of the same
		// accepted state is semantically idempotent, so sharing is safe.
		entry.pulling ??= (async () => {
			try {
				const transport = getPullTransport?.();
				if (transport === undefined) return DocumentPullError.NotAttached();
				// Only the carrier call is adapted. Applying the response below
				// must stay outside this wrapper: a refused local append is a
				// durability failure that revokes the handle, not a retryable
				// transport failure.
				const { data: response, error: transportError } = await tryAsync({
					try: async () =>
						transport({
							address: { ...entry.address },
							sinceVersion: entry.pulledVersion,
						}),
					catch: (cause) => DocumentPullError.TransportFailed({ cause }),
				});
				if (transportError !== null) return Err(transportError);
				// A pull that resolves after disposal or revocation must not
				// mutate the document; its result is simply dropped.
				if (!isEntryCurrent(entry)) return Ok(undefined);
				switch (response.kind) {
					case 'unchanged':
						return Ok(undefined);
					case 'not-live':
						// Scalar row-liveness owns the terminal deletion; the next
						// scalar exchange installs it and revokes this document.
						return DocumentPullError.RowNotLive();
					case 'state': {
						// The accepted origin persists these bytes locally without
						// minting a publication obligation.
						Y.applyUpdateV2(
							entry.document,
							new Uint8Array(response.update),
							acceptedDocumentOrigin,
						);
						entry.pulledVersion = response.version;
						return Ok(undefined);
					}
					default:
						return response satisfies never;
				}
			} finally {
				entry.pulling = undefined;
			}
		})();
		return entry.pulling;
	}

	function createHandle(entry: DocumentEntry): RowDocument {
		let isHandleDisposed = false;
		entry.references += 1;

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (entry.revoked !== undefined) throw entry.revoked;
		}

		const handle: RowDocument = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				requireUsable();
				return entry.document.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				requireUsable();
			},
			async pull(): Promise<Result<void, DocumentPullError>> {
				requireUsable();
				return pullEntry(entry);
			},
			async syncIssue(): Promise<DocumentSyncIssue> {
				requireUsable();
				return readPublication(entry.address)?.sync_issue === 'too-large'
					? { kind: 'too-large' }
					: null;
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				entry.references -= 1;
				if (entry.references === 0 && entry.revoked === undefined) {
					destroyEntry(entry);
				}
			},
		};
		registerRowDocumentConnectionTarget(handle, {
			address: { ...entry.address },
			applyUpdate(update, origin) {
				requireUsable();
				Y.applyUpdateV2(entry.document, new Uint8Array(update), origin);
			},
			encodeStateAsUpdate() {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(entry.document));
			},
			observe(listener) {
				requireUsable();
				entry.document.on('updateV2', listener);
				return () => entry.document.off('updateV2', listener);
			},
		});
		return handle;
	}

	const runtime = {
		async open(address: RowAddress): Promise<RowDocument> {
			const entry = await entryFor(address);
			requireRuntimeOpen();
			if (entry.revoked !== undefined) throw entry.revoked;
			return createHandle(entry);
		},
		/**
		 * Observe new local publication work. Fires after the transaction that
		 * advanced an obligation commits, so a subscriber that immediately
		 * drains reads the durable revision it was woken for.
		 */
		subscribePublicationDirty(listener: () => void): () => void {
			publicationDirtyListeners.add(listener);
			return () => publicationDirtyListeners.delete(listener);
		},
		/**
		 * Attempt every currently dirty address once through the supplied
		 * carrier with bounded concurrency: capture the current state and
		 * revision, transport it, and settle or record the outcome. One pass
		 * per call; the supervisor owns wake pacing, coalescing, and retry.
		 *
		 * The pass is a bounded attempt, not a guaranteed visit: the first
		 * transport failure stops workers from claiming further addresses, and
		 * disposal ends the pass wherever it stands. Whatever went unvisited
		 * stays durably dirty for the next one.
		 */
		async drainPublications(
			publish: PublishDocument,
		): Promise<Result<void, ReplicaV1Error>> {
			const { data: queue, error: listError } = drainStorage(() =>
				runtime.publication.listDirty(),
			);
			if (listError !== null) return Err(listError);
			// One pass returns one failure, so each kind keeps its first. They
			// stay separate because only a transport failure earns network
			// backoff from the supervisor.
			let transportFailure: ReplicaV1Error | undefined;
			let storageFailure: ReplicaV1Error | undefined;
			const workers = Array.from(
				{ length: Math.min(PUBLISH_CONCURRENCY, queue.length) },
				async () => {
					while (transportFailure === undefined && !isDisposed) {
						const address = queue.shift();
						if (address === undefined) return;
						const { data: captured, error: captureError } = drainStorage(() =>
							runtime.publication.capture(address),
						);
						if (captureError !== null) {
							// One address this pass cannot read must not starve the
							// others; the failure is reported after the pass.
							storageFailure ??= captureError;
							continue;
						}
						if (captured === undefined) continue;
						const { data: outcome, error: publishError } = await tryAsync({
							try: async () => publish({ address, update: captured.update }),
							catch: (cause) => ReplicaV1Error.TransportFailed({ cause }),
						});
						if (publishError !== null) {
							transportFailure ??= publishError;
							return;
						}
						if (isDisposed) return;
						// Both settlement writes mean one thing when they fail, so
						// they share a wrapper; the publish above keeps its own so a
						// refused write is never reported as network trouble.
						const { error: settlementError } = drainStorage(() => {
							switch (outcome) {
								case 'accepted':
									runtime.publication.settle(address, captured.revision);
									break;
								case 'not-live':
									// Scalar deletion owns removing the whole record; until
									// it arrives the address simply stays dirty.
									break;
								case 'too-large':
									runtime.publication.recordIssue(address);
									break;
								default:
									outcome satisfies never;
							}
						});
						if (settlementError !== null) storageFailure ??= settlementError;
					}
				},
			);
			await Promise.all(workers);
			if (transportFailure !== undefined) return Err(transportFailure);
			if (storageFailure !== undefined) return Err(storageFailure);
			return Ok(undefined);
		},
		/**
		 * The durable authority-publication obligation for row documents
		 * (ADR-0171/0174). Owned here because obligation state must commit in
		 * the same SQLite transactions as the update chain it describes; the
		 * runtime-owned drain reads and settles it through these operations and
		 * never through an open document handle.
		 */
		publication: {
			/** Addresses owing publication, stable order, terminal issues excluded. */
			listDirty(): RowAddress[] {
				return database
					.all<
						SqliteRow & {
							namespace: string;
							table_name: string;
							row_id: string;
						}
					>(
						`SELECT namespace, table_name, row_id FROM document_publication
						 WHERE revision > accepted_revision AND sync_issue IS NULL
						 ORDER BY namespace, table_name, row_id`,
					)
					.map(({ namespace, table_name, row_id }) => ({
						kind: 'row' as const,
						namespace,
						tableName: table_name,
						rowId: row_id,
					}));
			},
			/**
			 * Read one dirty address's current complete state and the revision it
			 * covers, in one transaction. Nothing is frozen: a racing local edit
			 * advances the revision and the next capture reconstructs newer
			 * state. Returns undefined when the address owes nothing.
			 */
			capture(
				address: RowAddress,
			): { update: Uint8Array; revision: number } | undefined {
				return database.transaction(() => {
					const record = readPublication(address);
					if (
						record === undefined ||
						record.revision <= record.accepted_revision ||
						record.sync_issue !== null
					) {
						return undefined;
					}
					const updates = readUpdates(address);
					if (updates.length === 0) return undefined;
					const hydrated = replay(updates);
					try {
						return {
							update: new Uint8Array(Y.encodeStateAsUpdateV2(hydrated)),
							revision: record.revision,
						};
					} finally {
						hydrated.destroy();
					}
				});
			},
			/**
			 * Advance the accepted revision through one captured revision and no
			 * further. Acceptance of revision N never clears N+1, so work
			 * authored during the request stays owed and republishes.
			 */
			settle(address: RowAddress, revision: number): void {
				database.run(
					`UPDATE document_publication SET
						accepted_revision = max(accepted_revision, min(?, revision))
					 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
					[revision, address.namespace, address.tableName, address.rowId],
				);
			},
			/**
			 * Record the terminal too-large condition for this lineage. The
			 * address leaves automatic publication permanently; the application
			 * owns recovery, typically by moving content to a fresh row
			 * (ADR-0174).
			 */
			recordIssue(address: RowAddress): void {
				database.run(
					`UPDATE document_publication SET sync_issue = 'too-large'
					 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
					[address.namespace, address.tableName, address.rowId],
				);
			},
			/** Durable obligation state for one address, or undefined if none. */
			status(address: RowAddress): DocumentPublicationStatus | undefined {
				const record = readPublication(address);
				if (!record) return undefined;
				return {
					revision: record.revision,
					acceptedRevision: record.accepted_revision,
					issue:
						record.sync_issue === 'too-large' ? { kind: 'too-large' } : null,
				};
			},
		},
		revoke(address: RowAddress): void {
			revokeWith(
				address,
				new Error(`Row document was revoked because '//' is no longer live`),
			);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			publicationDirtyListeners.clear();
			await Promise.allSettled(opening.values());
			for (const entry of [...entries.values()]) {
				entry.revoked = new Error('Epicenter document runtime is disposed');
				destroyEntry(entry);
			}
		},
	};
	return runtime;
}

function requireRowDocumentAccess(
	document: RowDocument,
): RowDocumentConnectionTarget {
	const access = rowDocumentAccess.get(document);
	if (access === undefined) throw new Error('Unknown row document handle');
	return access;
}

/** Apply one incremental V2 update at an adapter boundary. */
export function applyRowDocumentUpdate(
	document: RowDocument,
	update: Uint8Array,
	origin?: unknown,
): void {
	requireRowDocumentAccess(document).applyUpdate(update, origin);
}

/** Encode one initial state snapshot for an adapter boundary. */
export function encodeRowDocumentState(document: RowDocument): Uint8Array {
	return requireRowDocumentAccess(document).encodeStateAsUpdate();
}

/** Observe incremental V2 updates at an adapter boundary. */
export function observeRowDocumentUpdates(
	document: RowDocument,
	listener: UpdateListener,
): () => void {
	return requireRowDocumentAccess(document).observe(listener);
}

/** Read the registered adapter seam for one row document handle. */
export function rowDocumentConnectionTarget(
	document: RowDocument,
): RowDocumentConnectionTarget {
	return requireRowDocumentAccess(document);
}
