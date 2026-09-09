import { createAiConfiguration } from './ai-configuration.js';
import { accountInference, type AiTransport } from './ai.js';
import type { AppAiBinding } from './index.js';
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

/** Origin-local settings; supported Epicenter accounts supply the /v1 gateway. */
export function createBrowserAppAi(storageKey: string, configuredFetch?: AiTransport['fetch']): AppAiBinding {
 return {
  runtime: null,
  account: accountInference,
  configuredFetch,
  configuration() {
   return createAiConfiguration({
    storage: window.localStorage, storageKey,
    subscribeStorage(listener) {
     const changed = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === `${storageKey}.app-ai` || event.key === null)) listener();
     };
     window.addEventListener('storage', changed);
     return () => window.removeEventListener('storage', changed);
    },
   });
  },
 };
}
