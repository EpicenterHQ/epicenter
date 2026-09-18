import { claimApp } from '@epicenter/device/library-claim';
import { acquireAppData } from '../data/store/browser.js';
import { requestPersistentStorage } from '../data/store/persist.js';
import type { AppRuntime } from '../open.js';

/** Browser and host windows keep documents in their own realm's IndexedDB. */
export const nativeDocuments: Pick<AppRuntime, 'claim' | 'data'> = {
	claim: claimApp,
	data(definition, scope) {
		void requestPersistentStorage();
		return acquireAppData(definition, scope, {
			factory: globalThis.indexedDB,
			keyRange: globalThis.IDBKeyRange,
		});
	},
};
