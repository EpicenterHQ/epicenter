import type { Account } from '@epicenter/auth';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobRemote,
	createEpicenterClient,
} from '@epicenter/client';
import type { AppBlobComposition, AppBlobFactory } from './index.js';

/** Compose the standard browser/WebView blob capabilities for one app. */
export function createBrowserAppBlobs(): AppBlobFactory {
	return ({
		appId,
		account,
	}: {
		appId: string;
		account: Account | null;
	}): AppBlobComposition => {
		const local = createBrowserBlobStore(
			account === null
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
				: null,
		};
	};
}
