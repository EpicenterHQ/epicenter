import { deviceOwnerPath } from '@epicenter/principal';
import { type AiTransport, accountInference } from './ai.js';
import { createAiConnections } from './ai-connections.js';
import type { AppAiBinding, ApplicationRuntime } from './index.js';
import { resources as browserResources } from './platform/browser.js';

export { createBrowserAppBlobs } from './platform/browser.js';

/** Origin-local settings; supported Epicenter accounts supply the /v1 gateway. */
export function createBrowserAppAi(
	configuredFetch?: AiTransport['fetch'],
): AppAiBinding {
	return {
		runtime: null,
		account: accountInference,
		configuredFetch,
		connections(_appId, account) {
			const storageKey = `epicenter/ai/${deviceOwnerPath(account)}`;
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
};

/** Default browser composition selected by the package build condition. */
export const createDefaultAppAi: () => AppAiBinding = createBrowserAppAi;
