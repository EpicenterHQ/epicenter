import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createBrowserSecrets,
	createBrowserSqliteOwner,
} from '@epicenter/device/browser';
import { createBrowserAppAi } from '../browser.js';
import type { AppRuntime } from '../open.js';
import { createBrowserRecording } from '../recording/browser.js';
import { nativeDocuments } from './documents.js';

export const resources: AppRuntime = {
	...nativeDocuments,
	ai: createBrowserAppAi(),
	sqlite: createBrowserSqliteOwner(),
	blobs({ appId, account }) {
		const local = createBrowserBlobStore({
			appId,
			account,
			idb: { factory: globalThis.indexedDB, keyRange: globalThis.IDBKeyRange },
		});
		return {
			local,
			sources: createBrowserBlobSources(local),
			remote:
				account === undefined
					? null
					: createRemoteBlobClient({ appId, account, local }),
		};
	},
	recording: createBrowserRecording,
	secrets: createBrowserSecrets,
};
