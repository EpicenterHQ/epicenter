import { claimApp } from '@epicenter/device/library-claim';
import { acquireAppData } from '../data/store/browser.js';
import type { AppRuntime } from '../runtime.js';
import { createBrowserAppAi } from '../browser.js';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createBrowserSecrets,
	createBrowserSqliteOwner,
} from '@epicenter/device/browser';
import type { AppBlobFactory } from '../runtime.js';
import { createBrowserRecording } from '../recording/browser.js';

export function createBrowserAppBlobs(): AppBlobFactory {
	return ({ appId, account }) => {
		const local = createBrowserBlobStore({ appId, account });
		return {
			local,
			sources: createBrowserBlobSources(local),
			remote:
				account === undefined
					? null
					: createRemoteBlobClient({ appId, account, local }),
		};
	};
}

export const resources: AppRuntime = {
	claim: claimApp,
	data: acquireAppData,
	ai: createBrowserAppAi(),
	sqlite: createBrowserSqliteOwner(),
	blobs: createBrowserAppBlobs(),
	recording: createBrowserRecording,
	secrets: createBrowserSecrets,
};
