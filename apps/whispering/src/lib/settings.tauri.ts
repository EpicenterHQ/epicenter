/**
 * Whispering's settings notes on the desktop (decisions 86 to 89). The
 * AppData root holds this computer's, never synced:
 *
 * - `settings.md`: `folder`, the data folder this computer opens, absent
 *   for the default.
 * - `shortcuts.md`: this computer's override of the data folder's
 *   `shortcuts.md` (the contract's `shortcuts`), key by key.
 *
 * A reader resolves a note with a shallow spread, where it reads it: the
 * defaults, then the data folder's keys, then this computer's (`keysOf`
 * each).
 */
import { defineContract, type Version } from '@epicenter/definition/contract';
import { whispering } from './contract.js';

export const whisperingSettings = defineContract({
	name: 'whispering-settings',
	description:
		"Whispering's settings notes on this computer: `folder` is the data folder it opens; `shortcuts.md` overrides the data folder's.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
		shortcuts: whispering.collections.shortcuts,
	},
});

export type WhisperingSettings = typeof whisperingSettings;

/** `shortcuts.md` when neither root holds a key. */
export const SHORTCUT_DEFAULTS = {
	toggleRecording: 'CommandOrControl+Shift+;',
};

/** A settings note's keys, without what every note carries (its body and version); none for no note. */
export function keysOf<TNote extends { body: string; version: Version }>(
	note: TNote | undefined,
): Partial<Omit<TNote, 'body' | 'version'>> {
	if (note === undefined) return {};
	const { body: _body, version: _version, ...keys } = note;
	return keys;
}
