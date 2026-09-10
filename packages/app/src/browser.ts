import type { ApplicationRuntime } from './index.js';
import { resources as browserResources } from './platform/browser.js';
import { createBrowserRecording } from './recording/browser.js';
import { createAiConnections } from './ai-connections.js';
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
		connections() {
			return createAiConnections({
				storage: window.localStorage,
				storageKey,
				locks: navigator.locks,
				publishStorage() {
					window.dispatchEvent(
						new CustomEvent('epicenter-ai-connections', { detail: storageKey }),
					);
				},
				subscribeStorage(listener) {
					const changed = (event: StorageEvent) => {
						if (
							event.storageArea === window.localStorage &&
							(event.key === `${storageKey}.app-ai-connections` ||
								event.key === null)
						)
							listener();
					};
					const local = (event: Event) => {
						if ((event as CustomEvent<string>).detail === storageKey)
							listener();
					};
					window.addEventListener('storage', changed);
					window.addEventListener('epicenter-ai-connections', local);
					return () => {
						window.removeEventListener('storage', changed);
						window.removeEventListener('epicenter-ai-connections', local);
					};
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

/** Default browser composition selected by the package build condition. */
export const createDefaultAppAi: (storageKey: string) => AppAiBinding =
	createBrowserAppAi;
