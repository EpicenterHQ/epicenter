import { createWebviewBlobRemote, createWebviewBlobSources, createWebviewBlobStore } from '@epicenter/blobs/webview';
import type { AppBlobFactory } from '@epicenter/app';

/** The desktop host composes one app-scoped capability for capture, playback, and transfer. */
export const appBlobs: AppBlobFactory = ({ appId, account }) => {
	const local = createWebviewBlobStore({ appId });
	return {
		local,
		sources: createWebviewBlobSources(local, appId),
		remote: account === undefined ? null : createWebviewBlobRemote({ appId }),
	};
};
