/**
 * Browser capture, models and device preferences: `#platform/services`.
 * Capture records into `client`, this browser's files, as it records.
 *
 * Every request leaves this browser tab through its own `fetch`. Epicenter's
 * hosted models go through the signed-in account to Epicenter's API; a
 * connection the person saved, keys included, is kept in this site's
 * `localStorage` (`customEndpoints()`) and sent by the tab, so its endpoint
 * must allow requests from this origin (CORS). Ollama and LM Studio on this
 * computer are looked for the same way, and are found only when they allow
 * this origin.
 */

import {
	type Ai,
	customEndpoints,
	hosted,
	localServers,
	type ModelChoices,
	modelChoices,
	openAi,
} from '@epicenter/ai';
import { recorder } from '@epicenter/recorder/browser';
import { createMicrophoneDevice } from '../microphone.js';
import { localPreferences } from '../microphone-preference.js';
import { getAccount } from './auth.js';
import type { CreateServices } from './types.js';

/** Every model this tab reaches, and the one chosen for each job, made once for the page when the app first starts. */
let models:
	| { ai: Ai; choices: ModelChoices<'transcribe' | 'chat'> }
	| undefined;
function madeOnce() {
	models ??= {
		ai: openAi([hosted(getAccount()), customEndpoints(), localServers()]),
		choices: modelChoices<'transcribe' | 'chat'>(),
	};
	return models;
}

/** Whispering's services in a browser tab: `#platform/services`. */
export const createServices: CreateServices = (client) => ({
	capture: createMicrophoneDevice({ device: client, recorder }),
	...madeOnce(),
	connectionsNote: `A connection's key is kept in this browser's storage for this site, where code running on the site can read it. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS). Epicenter's models go through Epicenter's API and have no such limit.`,
	preferences: localPreferences,
});
