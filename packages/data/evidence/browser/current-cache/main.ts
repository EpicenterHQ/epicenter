/** Real-browser transaction controls for the current-cache proof, never imported by production. */
import * as Y from '@y/y';
import { createRow, tableRoot } from '../../../src/store/document.js';
import { openCurrentCache } from '../../../src/store/current-cache.js';

let backing: NonNullable<Awaited<ReturnType<typeof openCurrentCache>>['data']>;
let raw: IDBDatabase | undefined;
let release: (() => void) | undefined;
let pending: Promise<unknown> | undefined;
let settled = false;
const address = 'current-cache-proof';
const document = new Y.Doc();
createRow(tableRoot(document, 'notes'), 'one', { text: 'baseline' });
const bytes = Y.encodeStateAsUpdateV2(document);
document.destroy();

function observe(promise: Promise<unknown>) {
	settled = false;
	pending = promise.then(
		() => {
			settled = true;
			return 'ok';
		},
		() => {
			settled = true;
			return 'rejected';
		},
	);
}
async function rejected(promise: Promise<unknown>) {
	try {
		await promise;
		return false;
	} catch {
		return true;
	}
}

const probe = {
	async open() {
		const result = await openCurrentCache(address);
		if (result.error) throw result.error;
		backing = result.data;
		return backing.loaded === undefined
			? null
			: {
					generation: backing.loaded.generation,
					cursor: backing.loaded.snapshot.cursor,
					rows: backing.loaded.snapshot.updates.length,
					outbox: backing.loaded.snapshot.outbox.length,
					bytes: Array.from(backing.loaded.snapshot.updates[0]!),
				};
	},
	async install(generation = 1) {
		await backing.install({ generation, bytes, position: 7 });
		return Array.from(bytes);
	},
	async emptyInstallRefused() {
		return await rejected(
			backing.install({ generation: 5, bytes: new Uint8Array(), position: 9 }),
		);
	},
	async installMutableInput() {
		const record = { generation: 5, bytes: new Uint8Array(bytes), position: 9 };
		const expected = Array.from(record.bytes);
		const installing = backing.install(record);
		record.generation = 99;
		record.position = 100;
		record.bytes.fill(0);
		await installing;
		return expected;
	},

	async append(id = 2) {
		await backing.port.commit([
			{ kind: 'append', id, bytes, authoritySeq: undefined },
		]);
	},
	async openRaw() {
		raw = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(address, 1);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	},
	/** Keep the next actual backing transaction active until the runner releases it. */
	pauseNextTransaction() {
		const original = IDBDatabase.prototype.transaction;
		Object.defineProperty(IDBDatabase.prototype, 'transaction', {
			configurable: true,
			writable: true,
			value: function (this: IDBDatabase, ...args: unknown[]) {
				const transaction: IDBTransaction = Reflect.apply(original, this, args);
				if (this.name === address && transaction.mode === 'readwrite') {
					Object.defineProperty(IDBDatabase.prototype, 'transaction', {
						value: original,
						configurable: true,
						writable: true,
					});
					let held = true;
					release = () => {
						held = false;
					};
					function tick() {
						const request = transaction.objectStore('updates').get(1);
						request.onsuccess = () => {
							if (held) tick();
						};
					}
					tick();
				}
				return transaction;
			},
		});
	},
	startAppend() {
		observe(
			backing.port.commit([
				{ kind: 'append', id: 2, bytes, authoritySeq: undefined },
			]),
		);
	},
	async startDiscard() {
		const first = backing.discard();
		const same = first === backing.discard();
		observe(first);
		return {
			same,
			lateCommitRefused: await rejected(
				backing.port.commit([
					{ kind: 'append', id: 3, bytes, authoritySeq: undefined },
				]),
			),
			lateInstallRefused: await rejected(
				backing.install({ generation: 2, bytes, position: 8 }),
			),
		};
	},
	settled() {
		return settled;
	},
	async release() {
		release?.();
		return await pending;
	},
	/** Abort one invalidation or install transaction after its first destructive request. */
	abortNext(storeName: 'header' | 'updates', method: 'clear' | 'put') {
		const original = IDBObjectStore.prototype[method];
		// These overloads have different argument shapes; Reflect preserves the native call.
		Object.defineProperty(IDBObjectStore.prototype, method, {
			configurable: true,
			writable: true,
			value: function (this: IDBObjectStore, ...args: unknown[]) {
				const request: IDBRequest = Reflect.apply(original, this, args);
				if (this.name === storeName) {
					Object.defineProperty(IDBObjectStore.prototype, method, {
						value: original,
						configurable: true,
						writable: true,
					});
					this.transaction.abort();
				}
				return request;
			},
		});
	},
	async discard() {
		return await rejected(backing.discard());
	},
	async installRefused() {
		return await rejected(
			backing.install({ generation: 3, bytes, position: 9 }),
		);
	},
	async appendRefused() {
		return await rejected(
			backing.port.commit([
				{ kind: 'append', id: 4, bytes, authoritySeq: undefined },
			]),
		);
	},
	close() {
		backing.close();
		raw?.close();
		raw = undefined;
	},
	async rawState() {
		if (!raw) throw new Error('Open raw connection first');
		const transaction = raw.transaction(['header', 'updates']);
		const header = transaction.objectStore('header').get('generation');
		const rows = transaction.objectStore('updates').count();
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		return { generation: header.result ?? null, rows: rows.result };
	},
};
Object.assign(window, { probe });
export type CacheProbe = typeof probe;
