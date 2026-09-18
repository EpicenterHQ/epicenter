import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createDesktopSecrets,
	createDesktopSqliteOwner,
} from '@epicenter/device/desktop';
import { createEpicenterHostAppAi } from '../ai-connections.epicenter-host.js';
import { createDesktopRecording } from '../recording/desktop.js';
import type { AppRuntime } from '../runtime.js';
import { nativeDocuments } from './documents.js';

export const resources: AppRuntime = {
	...nativeDocuments,
	ai: createEpicenterHostAppAi(),
	sqlite: createDesktopSqliteOwner(),
	blobs({ appId, account }) {
		const bytes = createWebviewBlobs({ appId, account });
		return {
			...bytes,
			remote:
				account === undefined
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
