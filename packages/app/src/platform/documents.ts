import { claim } from '@epicenter/device/app-claim';
import { acquireLocalBlobs } from '../blob-owner.js';
import { acquireStoreData } from '../data/store/browser.js';
import { requestPersistentStorage } from '../data/store/persist.js';
import type { StoreRuntime } from '../store-runtime.js';

/** Browser and host windows keep documents in their own realm's IndexedDB. */
export const indexedDbStoreRuntime: StoreRuntime = {
	claim,
	localBlobs: (id, assertUsable) => acquireLocalBlobs({ id, assertUsable }),
	data(definition, owner) {
		void requestPersistentStorage();
		return acquireStoreData(definition, owner, {
			factory: globalThis.indexedDB,
			keyRange: globalThis.IDBKeyRange,
		});
	},
};
