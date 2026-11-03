/**
 * What Vocab's desktop window opens besides its data folder (decisions 88 to
 * 94): its AppData root's settings contract, and where Vocab publishes its
 * contract. Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';

/** Where Vocab's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.VOCAB.url}/contract.json`;

/**
 * Vocab's settings notes on this computer (decisions 86 to 89), at the top
 * of the AppData root and never synced:
 *
 * - `connections.md`: the connected endpoints in the learner's order, each
 *   one's id, name, base URL and models, never a key (`connections.tauri.ts`
 *   keeps each key in the keychain under the connection's id, so an id is a
 *   keychain name).
 */
export const vocabSettings = defineContract({
	description:
		"Vocab's connected endpoints on this computer: each one's id, name, base URL and models. Their keys are in the keychain.",
	collections: {
		connections: {
			path: 'connections.md',
			fields: {
				connections: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
							name: { type: 'string' },
							baseUrl: { type: 'string' },
							models: { type: 'array', items: { type: 'string' } },
						},
						required: ['id', 'name', 'baseUrl', 'models'],
					},
				},
			},
			required: ['connections'],
		},
	},
});

export type VocabSettings = typeof vocabSettings;
