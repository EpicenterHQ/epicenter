import type { ApplicationRuntime } from './index.js';
import { resources as browserResources } from './platform/browser.js';
import { createBrowserRecording } from './recording/browser.js';
import { createAiConfiguration } from './ai-configuration.js';
import { accountInference, type AiTransport } from './ai.js';
import type { AppAiBinding } from './index.js';
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
	return ({ appId, replica, remote }): AppBlobComposition => {
		const local = createBrowserBlobStore({ appId, replica });
		return {
			local,
			sources: createBrowserBlobSources(local),
			remote:
				remote === null
					? null
					: createBrowserBlobRemote({
							local,
							client: createEpicenterClient(remote),
						}),
		};
	};
}

/** Origin-local settings; supported Epicenter accounts supply the /v1 gateway. */
export function createBrowserAppAi(
	storageKey: string,
	configuredFetch?: AiTransport['fetch'],
): AppAiBinding {
	return {
		runtime: null,
		account: accountInference,
		configuredFetch,
		configuration() {
			return createAiConfiguration({
				storage: window.localStorage,
				storageKey,
				subscribeStorage(listener) {
					const changed = (event: StorageEvent) => {
						if (
							event.storageArea === window.localStorage &&
							(event.key === `${storageKey}.app-ai` || event.key === null)
						)
							listener();
					};
					window.addEventListener('storage', changed);
					return () => window.removeEventListener('storage', changed);
				},
			});
		},
	};
}

/** Browser storage and capture; importing this value acquires no resources. */
export const browser: ApplicationRuntime = {
	...browserResources,
	blobs: createBrowserAppBlobs(),
	recording: createBrowserRecording,
};
