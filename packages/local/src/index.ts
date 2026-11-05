/**
 * `@epicenter/local`: this computer's settings for an app. In a Tauri
 * window they are the app's AppData files, through the shell (`tauri.ts`,
 * loaded when the settings connect); in a browser, this browser's
 * `localStorage` for the site (`browser.ts`). Which is decided once, when
 * this module loads, with `isTauri()`. The `test` condition's leaf is
 * `memory.ts`.
 */
import { isTauri } from '@tauri-apps/api/core';
import { browserStorage } from './browser.js';
import { createSettings, type SettingsPlace } from './settings.js';

export {
	type Settings,
	SettingsError,
	type SettingsFile,
	SettingsNotOpen,
	type SettingsState,
} from './settings.js';

/** The AppData root, its code loaded the first time the settings ask it anything. */
const appData: SettingsPlace = {
	watch: async (changed) => (await import('./tauri.js')).appData.watch(changed),
	read: async (name) => (await import('./tauri.js')).appData.read(name),
	write: async (name, text) =>
		(await import('./tauri.js')).appData.write(name, text),
};

/** This computer's settings for this app. */
export const settings = createSettings(isTauri() ? appData : browserStorage);
