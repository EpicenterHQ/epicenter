import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { AppClaimError } from '@epicenter/device/app-claim';
import { createMemorySqliteOwner } from '@epicenter/device/memory';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Ok } from 'wellcrafted/result';
import { acquireLocalBlobs } from './blob-owner.js';
import { acquireStoreData } from './data/store/browser.js';
import type { StoreRuntime } from './store-runtime.js';

/**
 * Isolated storage using the same persistence services as production.
 * Its IndexedDB factory and key ranges belong to this runtime; globals never change.
 * stores close their handles; disposal erases this runtime's storage.
 */
export function createMemoryStoreRuntime() {
	const idb = { factory: new IDBFactory(), keyRange: IDBKeyRange };
	const sql = createMemorySqliteOwner();
	const held = new Set<string>();
	let disposed = false;
	let disposing: Promise<void> | undefined;
	const runtime: StoreRuntime = {
		sqlite: sql.owner.acquire,
		async claim(address) {
			if (disposed)
				return AppClaimError.ClaimFailed({
					address,
					cause: new Error('Memory runtime is disposed.'),
				});
			if (held.has(address)) return AppClaimError.AlreadyOpen({ address });
			held.add(address);
			let released = false;
			return Ok({
				release() {
					if (released) return;
					released = true;
					held.delete(address);
				},
			});
		},
		localBlobs(id, assertUsable) {
			const local = createBrowserBlobStore({ appId: id, idb });
			return acquireLocalBlobs({
				id,
				assertUsable,
				binding: {
					local,
					sources: createBrowserBlobSources(local),
					recording() {
						throw new Error('Memory runtime has no microphone binding.');
					},
				},
			});
		},
		data(definition, owner) {
			return acquireStoreData(definition, owner, idb);
		},
	};
	return {
		...runtime,
		/** Refuses active, pending, and failed-cleanup stores; never closes stores for callers. */
		async dispose() {
			if (held.size) throw new Error('Memory runtime still has open stores.');
			if (disposing) return disposing;
			sql.dispose();
			disposed = true;
			disposing = (async () => {
				for (const { name } of await idb.factory.databases()) {
					if (name === undefined) continue;
					await new Promise<void>((resolve, reject) => {
						const request = idb.factory.deleteDatabase(name);
						request.onsuccess = () => resolve();
						request.onerror = () => reject(request.error);
						request.onblocked = () =>
							reject(new Error('Memory storage is still open.'));
					});
				}
			})();
			return disposing;
		},
	};
}
