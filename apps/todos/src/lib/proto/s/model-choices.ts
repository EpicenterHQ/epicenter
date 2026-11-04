/**
 * PROTOTYPE option (s), the web leaf of a platform-supplied `modelChoices()`:
 * no place argument. On the web the site's own storage is the place (each app
 * is its own site, so the key names no app); the desktop leaf would keep the
 * same value in AppData through the shell.
 */
import { createModelChoices } from '../../../../../../packages/ai/src/choices.js';

const storageKey = 'epicenter/ai';

const counter = globalThis as unknown as { __models?: number; __modelsClosed?: number };

export function modelChoices() {
	counter.__models = (counter.__models ?? 0) + 1;
	const choices = createModelChoices({
		storage: window.localStorage,
		storageKey,
		subscribeStorage(listener) {
			const changed = (event: StorageEvent) => {
				if (event.key === `${storageKey}.model-choices` || event.key === null) listener();
			};
			window.addEventListener('storage', changed);
			return () => window.removeEventListener('storage', changed);
		},
	});
	const dispose = choices[Symbol.dispose];
	// Counted so a probe can see model choices built and never disposed.
	choices[Symbol.dispose] = () => {
		counter.__modelsClosed = (counter.__modelsClosed ?? 0) + 1;
		dispose();
	};
	return choices;
}
