import { claimApp } from '@epicenter/device/library-claim';
import { acquireAppData } from '../data/store/browser.js';
import type { AppRuntime } from '../runtime.js';
import { createEpicenterHostAppAi } from '../ai-connections.epicenter-host.js';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { createRemoteBlobClient } from '@epicenter/client';
import {
	createDesktopSecrets,
	createDesktopSqliteOwner,
} from '@epicenter/device/desktop';
import { createDesktopRecording } from '../recording/desktop.js';

export const resources: AppRuntime = {
	claim: claimApp,
	data: acquireAppData,
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
