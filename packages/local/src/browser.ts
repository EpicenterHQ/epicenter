/**
 * `@epicenter/local` in a web build (the `default` leaf): this computer's
 * settings are entries of this browser's `localStorage` for the site, under
 * `epicenter.local/<name>`. Each app is its own site, so the key names no
 * app. A read and a write are synchronous steps, so the page connects at
 * once; another tab's write arrives as a `storage` event.
 */
import { createSettings } from './settings.js';

export {
	type Settings,
	SettingsError,
	type SettingsFile,
	SettingsNotOpen,
	type SettingsState,
} from './settings.js';

const PREFIX = 'epicenter.local/';

/** This computer's settings for this app: this browser's storage for the site. */
export const settings = createSettings({
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
});
