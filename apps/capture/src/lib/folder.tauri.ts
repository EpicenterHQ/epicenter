/**
 * What Capture's desktop window opens besides its data folder (decisions 88
 * to 94): its AppData root's settings contract, and where Capture publishes
 * its contract. Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';

/** Where Capture's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.CAPTURE.url}/contract.json`;

/**
 * Capture's settings notes (decisions 86 to 89). Capture has no settings of
 * its own yet, so its one note is the AppData root's `settings.md`, whose
 * only key is `folder`: the data folder this computer opens, absent for the
 * default.
 */
export const captureSettings = defineContract({
	name: 'capture-settings',
	description:
		"Capture's settings notes: on this computer, `folder` is the data folder it opens.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

export type CaptureSettings = typeof captureSettings;
