/**
 * What Vocab's desktop window opens besides its data folder (decisions 88 to
 * 94): its AppData root's settings contract. Only the desktop leaves import this.
 */
import { connectionsCollection } from '@epicenter/ai/tauri';
import { defineContract } from '@epicenter/definition/contract';

/**
 * Vocab's settings notes on this computer (decisions 86 to 89), at the top
 * of the AppData root and never synced:
 *
 * - `connections.md`: the connected endpoints in the learner's order, each
 *   one's id, name, base URL and models, never a key
 *   (`connectionsCollection` from `@epicenter/ai/tauri`, which keeps each
 *   key in the keychain under the connection's id).
 */
export const vocabSettings = defineContract({
	description:
		"Vocab's connected endpoints on this computer: each one's id, name, base URL and models. Their keys are in the keychain.",
	collections: {
		connections: connectionsCollection,
	},
});

export type VocabSettings = typeof vocabSettings;
