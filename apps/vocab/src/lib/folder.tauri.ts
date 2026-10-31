/**
 * Vocab's desktop window's two roots as its components read them (decisions
 * 88 to 94): the AppData root's settings (`getAppData`, through Vocab's own
 * settings contract) and the data folder's client (`getDevice`), each
 * wrapped once for Svelte where `DesktopRoot` sets them, and where Vocab
 * publishes its contract. Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { defineContract } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Vocab } from './contract.js';

/** Where Vocab's web app publishes its contract (`static/contract.json`). */
export const CONTRACT_URL = `${APPS.VOCAB.url}/contract.json`;

/**
 * Vocab's settings notes on this computer (decisions 86 to 89), at the top
 * of the AppData root and never synced:
 *
 * - `settings.md`: `folder`, the data folder this computer opens, absent
 *   for the default.
 * - `connections.md`: the connected endpoints in the learner's order, each
 *   one's id, name, base URL and models, never a key (`connections.tauri.ts`
 *   keeps each key in the keychain under the connection's id, so an id is a
 *   keychain name).
 */
export const vocabSettings = defineContract({
	name: 'vocab-settings',
	description:
		"Vocab's settings on this computer, never synced: `folder` is the data folder it opens, and the connected endpoints are each one's id, name, base URL and models. Their keys are in the keychain.",
	collections: {
		settings: { path: 'settings.md', fields: { folder: { type: 'string' } } },
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

export const [getAppData, setAppData] =
	createContext<ReactiveClient<VocabSettings>>();
export const [getDevice, setDevice] = createContext<ReactiveClient<Vocab>>();
