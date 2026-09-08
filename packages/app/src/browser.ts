import type { Account } from '@epicenter/auth';
import { BlobRemoteError, type BlobRemote } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import type { AppBlobComposition, AppBlobFactory } from './index.js';

const noRemote: BlobRemote = {
	upload: async () => BlobRemoteError.RemoteNotConfigured(),
	download: async () => BlobRemoteError.RemoteNotConfigured(),
	purge: async () => BlobRemoteError.RemoteNotConfigured(),
};

/** Compose the standard browser/WebView blob capabilities for one app. */
export function createBrowserAppBlobs(): AppBlobFactory {
	return ({ appId, account }: { appId: string; account: Account | undefined }): AppBlobComposition => {
		const local = createBrowserBlobStore(
			account === undefined
				? { appId, principalId: 'local' }
				: {
						appId,
						principalId: account.principalId,
						authorityId: account.authorityId,
					},
		);
		return {
			local,
			sources: createBrowserBlobSources(local),
			remote: account
				? createBrowserBlobRemote({
						local,
						client: createEpicenterClient({
							baseURL: account.baseURL,
							fetch: account.fetch,
						}),
					})
				: noRemote,
		};
	};
}
