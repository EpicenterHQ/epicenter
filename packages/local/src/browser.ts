/**
 * This computer's settings in a browser: entries of this browser's
 * `localStorage` for the site, under `epicenter.local/<name>`. Each app is
 * its own site, so the key names no app. A read and a write are synchronous
 * steps, so the page connects at once; another tab's write arrives as a
 * `storage` event.
 */
import type { SettingsPlace } from './settings.js';

const PREFIX = 'epicenter.local/';

/** This browser's storage for the site, as the place the settings are kept. */
export const browserStorage: SettingsPlace = {
	async watch(changed) {
		if (typeof window === 'undefined') return () => {};
		const heard = (event: StorageEvent) => {
			if (event.storageArea !== window.localStorage) return;
			if (event.key === null) changed('all');
			else if (event.key.startsWith(PREFIX))
				changed([event.key.slice(PREFIX.length)]);
		};
		window.addEventListener('storage', heard);
		return () => window.removeEventListener('storage', heard);
	},
	async read(name) {
		return localStorage.getItem(PREFIX + name);
	},
	async write(name, text) {
		if (text === null) localStorage.removeItem(PREFIX + name);
		else localStorage.setItem(PREFIX + name, text);
	},
};
