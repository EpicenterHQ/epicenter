/**
 * Honeycrisp's desktop window's folder and settings (decisions 81 and 82),
 * from the roots the shell gave it, and the folder as Honeycrisp's client:
 * null until the person chooses where Honeycrisp keeps its notes. Honeycrisp
 * keeps no machine setting but the folder, so its settings are `appConfig`'s.
 * Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { desktopFolder, openDevice } from '@epicenter/folder/tauri';
import { honeycrisp } from './contract.js';

/** The window's folder and settings, or null outside Honeycrisp's desktop shell. */
export const folder = desktopFolder({
	// Where Honeycrisp's web app publishes its contract (`static/contract.json`).
	contract: `${APPS.HONEYCRISP.url}/contract.json`,
});

/** The folder as Honeycrisp's client, or null before the first choice. */
export const device =
	folder === null || folder.path === null
		? null
		: openDevice(honeycrisp, { path: folder.path });
