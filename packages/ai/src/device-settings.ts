/**
 * `#device-settings` in a browser: the person's connected endpoints, keys
 * included, kept in this browser's storage for the site and sent by the
 * page. The desktop's is `device-settings.tauri.ts`, whose keys are in the
 * keychain and sent by the shell; the build picks one (the `tauri`
 * condition), so an app calls the same `customEndpoints()` in both.
 */
import { createAiConnections } from './ai-connections.js';
import { type CustomEndpoints, customEndpointsOf } from './custom-endpoints.js';

/** This browser's connections live under this key. */
const BROWSER_STORAGE_KEY = 'epicenter/ai';

/** The connections a person made in this browser, kept in its storage for this site, keys included. */
export function createBrowserConnections() {
	return createAiConnections({
		storage: window.localStorage,
		storageKey: BROWSER_STORAGE_KEY,
		locks: navigator.locks,
		publishStorage() {
			window.dispatchEvent(
				new CustomEvent('epicenter-ai-connections', {
					detail: BROWSER_STORAGE_KEY,
				}),
			);
		},
		subscribeStorage(listener) {
			const changed = (event: StorageEvent) => {
				if (
					event.storageArea === window.localStorage &&
					(event.key === `${BROWSER_STORAGE_KEY}.app-ai-connections` ||
						event.key === null)
				)
					listener();
			};
			const local = (event: Event) => {
				if ((event as CustomEvent<string>).detail === BROWSER_STORAGE_KEY)
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
}

/** The person's connected endpoints on this device, as one entry of `openAi([...])`. */
export function customEndpoints(): CustomEndpoints {
	return customEndpointsOf(async () => createBrowserConnections());
}
