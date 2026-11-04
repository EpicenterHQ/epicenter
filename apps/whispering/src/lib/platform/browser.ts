/**
 * Browser capture, endpoints and device preferences: `#platform/services`.
 * Capture records into `client`, this browser's files, as it records.
 *
 * Every request leaves this browser tab through its own `fetch`. Epicenter's
 * hosted models go through the signed-in account to Epicenter's API; a
 * connection the person saved, keys included, is kept in this site's
 * `localStorage` and sent by the tab, so its endpoint must allow requests
 * from this origin (CORS). Ollama and LM Studio on this computer are looked
 * for the same way, and are found only when they allow this origin.
 */

import { hosted, localServers } from '@epicenter/ai';
import { createBrowserModelChoices } from '@epicenter/ai/choices';
import { createBrowserConnections } from '@epicenter/ai/connections';
import { recorder } from '@epicenter/recorder/browser';
import { createMicrophoneDevice } from '../microphone.js';
import { localPreferences } from '../microphone-preference.js';
import { getAuth } from './auth.js';
import type { CreateServices } from './types.js';

/** Whispering's services in a browser tab: `#platform/services`. */
export const createServices: CreateServices = (client) => {
	const local = localServers();
	return {
		capture: createMicrophoneDevice({ device: client, recorder }),
		endpoints: {
			hosted() {
				const { state } = getAuth();
				return hosted(state.status === 'signed-out' ? null : state.account);
			},
			local,
			openConnections: async () => createBrowserConnections(),
			openChoices: () => createBrowserModelChoices('whispering'),
			note: `A connection's key is kept in this browser's storage for this site, where code running on the site can read it. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS). Epicenter's models go through Epicenter's API and have no such limit.`,
		},
		preferences: localPreferences,
	};
};
