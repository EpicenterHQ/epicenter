/**
 * Whispering's settings notes on the desktop (decisions 86 to 89), at the
 * top of the AppData root: this computer's, never synced.
 *
 * - `settings.md`: `folder`, the data folder this computer opens, absent
 *   for the default.
 */
import { defineContract } from '@epicenter/definition/contract';

export const whisperingSettings = defineContract({
	name: 'whispering-settings',
	description:
		"Whispering's settings notes: on this computer, `folder` is the data folder it opens.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
	},
});

export type WhisperingSettings = typeof whisperingSettings;
