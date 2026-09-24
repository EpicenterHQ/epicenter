import { claim } from '@epicenter/device/app-claim';
import { createBrowserSqliteOwner } from '@epicenter/device/browser';
import { createDesktopSqliteOwner } from '@epicenter/device/desktop';
import { isTauri } from '@tauri-apps/api/core';
import { acquireLocalBlobs } from '../blob-owner.js';
import { acquireStoreData } from '../data/store/browser.js';
import { requestPersistentStorage } from '../data/store/persist.js';
import type { StoreRuntime } from '../store-runtime.js';

const browserSqlite = createBrowserSqliteOwner();
const desktopSqlite = createDesktopSqliteOwner();

/** Browser and host windows keep documents in their own realm's IndexedDB. */
export const indexedDbStoreRuntime: StoreRuntime = {
	claim,
	sqlite: (id, account) =>
		(isTauri() ? desktopSqlite : browserSqlite).acquire(id, account),
	localBlobs: (id, assertUsable) => acquireLocalBlobs({ id, assertUsable }),
	data(definition, owner) {
		void requestPersistentStorage();
		return acquireStoreData(definition, owner, {
			factory: globalThis.indexedDB,
			keyRange: globalThis.IDBKeyRange,
		});
	},
};
