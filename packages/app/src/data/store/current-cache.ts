/**
 * Synchronized store cache at one stable IndexedDB address.
 * The caller owns the App claim until discard and App cleanup finish.
 */
import { tryAsync } from 'wellcrafted/result';
import { StoreError } from './errors.js';
import {
	type BrowserDurableSchema,
	createIdbUpdates,
	type IdbRealm,
	idbRequest,
	idbTransactionDone,
	openIdbDatabase,
	readIdbUpdates,
} from './idb-updates.js';
import { copyBytes } from './log.js';
import type { DurableOp, DurableSnapshot } from './persistence.js';

/** Open a cache without authorizing remote creation or selecting a generation. */
export async function openCurrentCache(address: string, idb: IdbRealm) {
	const opened = await tryAsync({
		try: () => openIdbDatabase(address, ['updates', 'header'], idb),
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (opened.error) return opened;
	const database = opened.data;
	const result = await tryAsync({
		try: async () => {
			const read = database.transaction(['header', 'updates'], 'readonly');
			const [generation, snapshot] = await Promise.all([
				idbRequest(read.objectStore('header').get('generation')) as Promise<
					number | undefined
				>,
				readIdbUpdates(read.objectStore('updates')),
				idbTransactionDone(read),
			]);
			if (
				generation !== undefined &&
				(!Number.isSafeInteger(generation) ||
					generation < 1 ||
					snapshot.updates.length === 0 ||
					snapshot.updates.some((bytes) => bytes.byteLength === 0))
			) {
				throw new Error('Current cache has an incomplete generation');
			}
			const loaded =
				generation === undefined ? undefined : { generation, snapshot };
			let engine =
				loaded === undefined
					? undefined
					: createIdbUpdates(database, snapshot, idb);
			let isFenced = false;
			let isInstalling = false;
			let discarding: Promise<void> | undefined;

			return {
				loaded,
				port: {
					async commit(ops: readonly DurableOp[]): Promise<void> {
						if (isFenced)
							throw new Error('Current cache backing is retired or closed');
						if (!engine)
							throw new Error('Current cache has no installed generation');
						await engine.port.commit(ops);
					},
				},
				/** Install a complete download once. The generation and bytes share one transaction. */
				async install(record: {
					generation: number;
					bytes: Uint8Array;
					position: number;
				}): Promise<DurableSnapshot> {
					if (isFenced)
						throw new Error('Current cache backing is retired or closed');
					if (engine || isInstalling)
						throw new Error('Current cache already has a generation');
					const { generation, position } = record;
					if (
						!Number.isSafeInteger(generation) ||
						generation < 1 ||
						!Number.isSafeInteger(position) ||
						position < 0 ||
						record.bytes.byteLength === 0
					) {
						throw new Error(
							'Current cache requires a valid generation, position, and nonempty baseline',
						);
					}
					const bytes = copyBytes(record.bytes);
					isInstalling = true;
					try {
						const transaction = database.transaction(
							['header', 'updates'],
							'readwrite',
						);
						const done = idbTransactionDone(transaction);
						try {
							if (
								(await idbRequest(
									transaction.objectStore('header').get('generation'),
								)) !== undefined
							) {
								throw new Error('Current cache already has a generation');
							}
							transaction.objectStore('updates').clear();
							transaction
								.objectStore('updates')
								.put({ bytes, authoritySeq: position }, 1);
							transaction.objectStore('header').put(generation, 'generation');
							await done;
							const installed = {
								updates: [bytes],
								outbox: [],
								cursor: position,
								lastId: 1,
							};
							// Discard may have fenced this lifetime while installation was pending.
							if (isFenced)
								throw new Error(
									'Current cache backing retired during installation',
								);
							engine = createIdbUpdates(database, installed, idb);
							return installed;
						} catch (cause) {
							try {
								transaction.abort();
							} catch {
								/* Already settled. */
							}
							await done.catch(() => {});
							throw cause;
						}
					} finally {
						isInstalling = false;
					}
				},
				/** Permanently fence this lifetime, then atomically remove the header and rows. */
				discard(): Promise<void> {
					isFenced = true;
					if (discarding) return discarding;
					discarding = (async () => {
						const transaction = database.transaction(
							['header', 'updates'],
							'readwrite',
						);
						const done = idbTransactionDone(transaction);
						try {
							transaction.objectStore('header').clear();
							transaction.objectStore('updates').clear();
							await done;
						} catch (cause) {
							try {
								transaction.abort();
							} catch {
								/* Already settled. */
							}
							await done.catch(() => {});
							throw cause;
						}
					})();
					// A failed discard permits another explicit attempt, never another write.
					void discarding.catch(() => {
						discarding = undefined;
					});
					return discarding;
				},
				close(): void {
					isFenced = true;
					database.close();
				},
			};
		},
		catch: (cause) => StoreError.StorageFailed({ cause }),
	});
	if (result.error) database.close();
	return result;
}
