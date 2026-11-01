/**
 * What Honeycrisp's desktop window opens besides its data folder (decisions
 * 88 to 94): its AppData root's settings contract, and where Honeycrisp
 * publishes its contract. Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';

/** Where Honeycrisp's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.HONEYCRISP.url}/contract.json`;

/**
 * Honeycrisp's settings notes (decisions 86 to 89). Honeycrisp has no settings of
 * its own yet, so its one note is the AppData root's `settings.md`, whose
 * only key is `folder`: the data folder this computer opens, absent for the
 * default.
 */
export const honeycrispSettings = defineContract({
	name: 'honeycrisp-settings',
	description:
		"Honeycrisp's settings notes: on this computer, `folder` is the data folder it opens.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

export type HoneycrispSettings = typeof honeycrispSettings;
