import type { ApplicationRuntime } from './index.js';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { resources } from './platform/epicenter-host.js';
import { createDesktopRecording } from './recording/desktop.js';

/** Native capture and host access to the same app-scoped files. */
export const epicenterHost: ApplicationRuntime = {
	...resources,
	blobs: createWebviewBlobs,
	recording: createDesktopRecording,
};

export { createEpicenterHostAppAi } from './ai-connections.epicenter-host.js';
