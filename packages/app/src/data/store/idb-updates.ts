/** Shared append-sized IndexedDB persistence for numbered and current caches. */
import * as Y from '@y/y';
import {
	copyBytes,
	NO_AUTHORITY,
	replay,
	SNAPSHOT_FOLD_THRESHOLD,
} from './log.js';
import type {
	DurableOp,
	DurablePort,
	DurableSnapshot,
	OutboxEntry,
} from './persistence.js';

type StoredUpdateRecord = {
	bytes: Uint8Array;
	/** `null` is owed: the authority has no position for these bytes. */
	authoritySeq: number | null;
};

/** The storage factory and key-range constructors belong to the same runtime. */
export type IdbRealm = { factory: IDBFactory; keyRange: typeof IDBKeyRange };

export function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.addEventListener('success', () => resolve(request.result), {
			once: true,
		});
		request.addEventListener('error', () => reject(request.error), {
			once: true,
		});
	});
}

/** A request error starts abort; only the abort event proves rollback has finished. */
export function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
	let firstError: DOMException | null = null;
	const done = new Promise<void>((resolve, reject) => {
		transaction.addEventListener('error', (event) => {
			firstError ??= (event.target as IDBRequest).error;
		});
		transaction.addEventListener('complete', () => resolve(), { once: true });
		transaction.addEventListener(
			'abort',
			() => {
				reject(
					firstError ??
						transaction.error ??
						new DOMException('Transaction aborted', 'AbortError'),
				);
			},
			{ once: true },
		);
	});
	// Synchronous JavaScript can throw before the caller reaches its settlement await.
	void done.catch(() => {});
	return done;
}

/** Open the existing format without discovering or migrating historical caches. */
export function openIdbDatabase(
	address: string,
	stores: readonly ('updates' | 'header')[],
	idb: IdbRealm,
): Promise<IDBDatabase> {
	const request = idb.factory.open(address, 1);
	const opened = idbRequest(request);
	request.addEventListener('upgradeneeded', () => {
		for (const store of stores) {
			if (!request.result.objectStoreNames.contains(store))
				request.result.createObjectStore(store);
		}
	});
	return opened;
}

const UPDATES_STORE = 'updates';

export async function readIdbUpdates(
	updateStore: IDBObjectStore,
): Promise<DurableSnapshot> {
	let rows: StoredUpdateRecord[];
	let ids: number[];
	[rows, ids] = await Promise.all([
		idbRequest(updateStore.getAll()),
		idbRequest(updateStore.getAllKeys()) as Promise<number[]>,
	]);

	// One pass over the chain answers everything the snapshot holds, which
	// is the shape of the collapse: the outbox and the cursor are read off
	// the appends rather than kept beside them.
	const stored: { id: number; bytes: Uint8Array }[] = [];
	const outbox: OutboxEntry[] = [];
	let cursor = 0;
	let lastId = 0;
	// Not copied, and the SQL port's `copyBytes` is not an inconsistency
	// here. `bun:sqlite` can hand back a view over memory it still owns,
	// so that port has to copy; `getAll` structured-clones, so these
	// arrays are already this caller's alone. Copying them again bought
	// nothing and cost a second whole document on every boot, because the
	// baseline row IS the whole document.
	//
	// One array per row, shared by `stored` and `outbox`: an owed row
	// appears in both and neither ever writes through it.
	for (const [index, row] of rows.entries()) {
		const id = ids[index] as number;
		if (id > lastId) lastId = id;
		const bytes = row.bytes;
		stored.push({ id, bytes });
		if (row.authoritySeq === null) {
			// NULL means owed, on every store kind (ADR-0301). A store with
			// no authority records `NO_AUTHORITY` on its own appends, so it
			// reaches this branch for nothing and needs no flag to say so.
			outbox.push({ id, bytes });
		} else if (row.authoritySeq > cursor) {
			cursor = row.authoritySeq;
		}
	}
	// Not sorted, because they are already in order and saying so is the
	// point. `getAll` returns an object store's rows in ascending key
	// order, and both arrays are pushed in that one iteration. Sorting
	// them was a no-op on every real input, and worse than a no-op as
	// documentation: this loop ALREADY depends on that ordering, pairing
	// `rows[index]` with `ids[index]`, so a defensive sort implied a
	// doubt the line above it does not share. The fold and `held` depend
	// on it too. One dependency, stated once.

	const loaded: DurableSnapshot = {
		updates: stored.map((row) => row.bytes),
		outbox,
		cursor,
		lastId,
	};
	return loaded;
}

export function createIdbUpdates(
	durable: IDBDatabase,
	loaded: DurableSnapshot,
	idb: IdbRealm,
) {
	let held = loaded.updates.length;
	const port: DurablePort = {
		async commit(ops: readonly DurableOp[]): Promise<void> {
			const transaction = durable.transaction(UPDATES_STORE, 'readwrite');
			const done = idbTransactionDone(transaction);
			const updates = transaction.objectStore(UPDATES_STORE);
			const writes: Promise<unknown>[] = [];
			function track(operation: IDBRequest): void {
				const request = idbRequest(operation);
				// Attach now: another awaited request may fail before settlement.
				// Keep the original rejection for the batch's final await.
				void request.catch(() => {});
				writes.push(request);
			}
			writes.push(done);
			try {
				let chain = held;
				let grew = false;
				for (const op of ops) {
					switch (op.kind) {
						case 'append': {
							track(
								updates.put(
									{
										bytes: copyBytes(op.bytes),
										authoritySeq: op.authoritySeq ?? null,
									},
									op.id,
								),
							);
							chain += 1;
							grew = true;
							break;
						}
						case 'mergeOwed': {
							for (const replaced of op.replaces) {
								track(updates.delete(replaced));
							}
							track(
								updates.put(
									{ bytes: copyBytes(op.bytes), authoritySeq: null },
									op.id,
								),
							);
							chain = chain - op.replaces.length + 1;
							break;
						}
						case 'ack': {
							// One statement's worth of work, and the shape it takes here
							// is what a keyed object store makes cheap. A cursor walk
							// costs one round trip PER ROW to advance, which is what
							// made a wide ack -- a device reconnecting with a day of
							// offline work owed -- the slowest thing this port does.
							// Reading the range in two requests and issuing the stamps
							// without awaiting them costs two round trips for the whole
							// batch instead of one per row.
							//
							// The reads are the price: the range includes the baseline,
							// so a wide ack holds one document in memory while it runs.
							// That is bounded by the document rather than by the
							// backlog, and it is paid once per ack rather than per row.
							// `evidence/browser/port-cost` measures both shapes.
							const range = idb.keyRange.upperBound(op.throughId);
							const [keys, rows] = await Promise.all([
								idbRequest(updates.getAllKeys(range)),
								idbRequest(updates.getAll(range)) as Promise<
									StoredUpdateRecord[]
								>,
							]);
							for (const [index, key] of keys.entries()) {
								const row = rows[index];
								if (row === undefined || row.authoritySeq !== null) continue;
								track(
									updates.put({ ...row, authoritySeq: op.authoritySeq }, key),
								);
								grew = true;
							}
							break;
						}
					}
				}

				// The same fold the SQL engine applies, and the same question:
				// an acknowledged row may be replaced by a whole-document
				// re-encode, an owed row may not (ADR-0301). A store with no
				// authority holds no owed rows, so it collapses everything here
				// without being told which kind it is.
				if (grew && chain >= SNAPSHOT_FOLD_THRESHOLD) {
					const foldable: { id: number; bytes: Uint8Array }[] = [];
					let position: number | null = null;
					const [keys, rows] = await Promise.all([
						idbRequest(updates.getAllKeys()),
						idbRequest(updates.getAll()) as Promise<StoredUpdateRecord[]>,
					]);
					// Both requests enumerate ascending keys in this same transaction.
					for (const [index, row] of rows.entries()) {
						if (row.authoritySeq !== null) {
							foldable.push({ id: keys[index] as number, bytes: row.bytes });
							if (row.authoritySeq > (position ?? -1))
								position = row.authoritySeq;
						}
					}
					const through = foldable.at(-1)?.id;
					if (
						foldable.length >= SNAPSHOT_FOLD_THRESHOLD &&
						through !== undefined
					) {
						const folded = replay(
							foldable.map((row) => ({ seq: row.id, bytes: row.bytes })),
						);
						let baseline: Uint8Array;
						try {
							baseline = new Uint8Array(Y.encodeStateAsUpdateV2(folded));
						} finally {
							folded.destroy();
						}
						for (const row of foldable) track(updates.delete(row.id));
						// The baseline inherits the highest position it replaced, so
						// on a syncing store it is not owed and is never offered back.
						track(
							updates.put(
								{ bytes: baseline, authoritySeq: position ?? NO_AUTHORITY },
								through,
							),
						);
						chain = chain - foldable.length + 1;
					}
				}

				await Promise.all(writes);
				// Advanced only after the batch landed, so a retried batch
				// recomputes from the same starting point.
				held = chain;
			} catch (cause) {
				// A JavaScript failure does not abort IndexedDB automatically.
				// Preserve the original error if a request already aborted it.
				try {
					transaction.abort();
				} catch {
					/* Already settled. */
				}
				const settled = await Promise.allSettled(writes);
				// An earlier request may have caused later reads to fail with AbortError.
				const failure = settled.find(
					(result) =>
						result.status === 'rejected' &&
						result.reason?.name !== 'AbortError',
				);
				throw failure?.status === 'rejected' ? failure.reason : cause;
			}
		},
	};

	async function create(record: {
		bytes: Uint8Array;
		position: number;
	}): Promise<void> {
		const transaction = durable.transaction(UPDATES_STORE, 'readwrite');
		const done = idbTransactionDone(transaction);
		try {
			transaction.objectStore(UPDATES_STORE).put(
				{
					bytes: copyBytes(record.bytes),
					authoritySeq: record.position,
				},
				1,
			);
			await done;
			held = 1;
		} catch (cause) {
			try {
				transaction.abort();
			} catch {
				/* Already settled. */
			}
			await done.catch(() => {});
			throw cause;
		}
	}

	return { port, create };
}
