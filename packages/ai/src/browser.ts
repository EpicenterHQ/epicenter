import { createAiConnections } from './ai-connections.js';

/**
 * This browser's connections live under this key. `no-account` is left from
 * when keys were split by account; browsers already hold data under it, so the
 * literal stays as written.
 */
const storageKey = 'epicenter/ai/no-account';

export function createBrowserConnections() {
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
				if ((event as CustomEvent<string>).detail === storageKey) listener();
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
