import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createDesktopSecrets,
	createDesktopSqliteOwner,
} from '@epicenter/device/desktop';
import { createDesktopRecording } from '../recording/desktop.js';
import type { resources as browserResources } from './browser.js';

export const resources: typeof browserResources = {
	sqlite: createDesktopSqliteOwner(),
	blobs({ appId, account }) {
		const bytes = createWebviewBlobs({ appId });
		return {
			...bytes,
			remote:
				account === null
					? null
					: createRemoteBlobClient({
							appId,
							account,
							local: bytes.local,
							host: true,
						}),
		};
	},
	recording: createDesktopRecording,
	secrets: createDesktopSecrets,
};
