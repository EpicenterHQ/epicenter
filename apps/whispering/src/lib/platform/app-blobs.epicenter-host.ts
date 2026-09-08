import { BlobRemoteError, type BlobRemote } from '@epicenter/blobs';
import { createWebviewBlobRemote, createWebviewBlobSources, createWebviewBlobStore, type WebviewBlobScope } from '@epicenter/blobs/webview';
import type { AppBlobFactory } from '@epicenter/app';

/** The desktop host composes one app-scoped capability for capture, playback, and transfer. */
export const appBlobs: AppBlobFactory = ({ appId, account }) => {
	const scope: WebviewBlobScope = account === undefined
		? { kind: 'local' }
		: { kind: 'account', authorityId: account.authorityId, principalId: account.principalId };
	const local = createWebviewBlobStore({ appId, scope });
	const remote: BlobRemote = account === undefined
		? {
				upload: async () => BlobRemoteError.RemoteNotConfigured(),
				download: async () => BlobRemoteError.RemoteNotConfigured(),
				purge: async () => BlobRemoteError.RemoteNotConfigured(),
			}
		: createWebviewBlobRemote({ appId, scope });
	return {
		local,
		sources: createWebviewBlobSources(local, appId, scope),
		remote,
	};
};
