import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { createAiConnections } from './ai-connections.js';

export function createBrowserConnections(account?: AccountIdentity) {
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
