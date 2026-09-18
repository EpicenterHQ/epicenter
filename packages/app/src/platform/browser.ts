import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createBrowserSecrets,
	createBrowserSqliteOwner,
} from '@epicenter/device/browser';
import type { AppBlobFactory } from '../compose.js';
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

export const resources = {
	sqlite: createBrowserSqliteOwner(),
	blobs: createBrowserAppBlobs(),
	recording: createBrowserRecording,
	secrets: createBrowserSecrets,
};
