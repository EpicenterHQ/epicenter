import type { ApplicationRuntime } from './index.js';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { resources } from './platform/epicenter-host.js';
import { createDesktopRecording } from './recording/desktop.js';
import { invoke } from '@tauri-apps/api/core';
import { blobDestination } from '@epicenter/blobs/native';

/** Native capture and host access to the same app-scoped files. */
export const epicenterHost: ApplicationRuntime = {
	...resources,
	blobs(options) {
		const destination = blobDestination(options.appId, options.replica);
		return createWebviewBlobs({
			...options,
			publishNative: (fileId, storageId, originGeneration) =>
				invoke('publish_recording_file', {
					fileId,
					storageId,
					originGeneration,
					destination,
				}),
		});
	},
	recording: createDesktopRecording,
};

export { createEpicenterHostAppAi } from './ai-connections.epicenter-host.js';
