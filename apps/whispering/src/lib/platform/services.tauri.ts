/**
 * Whispering's services in its desktop app: `#platform/services` under the
 * `tauri` condition, over the data folder the window opened.
 *
 * - Capture is the shell's microphone (`recorder` from
 *   `@epicenter/recorder/tauri`, ADR-0571), which writes each recording into
 *   the data folder from its first sample, as Opus in WebM placed at
 *   `recordings/<id>.webm` when it stops; a quit, a crash, or a closed window
 *   keeps the audio up to about its last second, which recovery finishes and
 *   places on the next launch.
 * - Epicenter's hosted models go through the signed-in account, whose
 *   requests the shell sends with a token this page never holds
 *   (`account_fetch`).
 * - A connection the person saved (`customEndpoints()`, the desktop's under
 *   the `tauri` condition) is listed in AppData's `connections.md` and its
 *   key is in the credential store, both written through the shell. Its
 *   requests leave through the shell, which adds the key
 *   (`connection_fetch`), so the key never reaches this page and no endpoint
 *   needs to allow the window's origin.
 * - Ollama and LM Studio on this computer are reached through the same shell
 *   fetch with no key (`shellFetch`), since neither answers a `tauri://` page.
 * - Transcription on this computer runs in this app's process
 *   (`localSpeech()` from `@epicenter/transcription`).
 */

import {
	type Ai,
	customEndpoints,
	hosted,
	localServers,
	openAi,
} from '@epicenter/ai';
import { createBrowserModelChoices } from '@epicenter/ai/choices';
import { shellFetch } from '@epicenter/ai/tauri';
import { recorder } from '@epicenter/recorder/tauri';
import { localSpeech } from '@epicenter/transcription';
import { createMicrophoneDevice } from '../microphone.js';
import { localPreferences } from '../microphone-preference.js';
import { getAccount } from './auth.tauri.js';
import type { CreateServices } from './types.js';

/** Every model this window reaches, made once for the page, when the app first starts. */
let ai: Ai | undefined;
function madeOnce(): Ai {
	ai ??= openAi([
		hosted(getAccount()),
		customEndpoints(),
		localServers({ fetch: shellFetch }),
		localSpeech(),
	]);
	return ai;
}

/** Whispering's services in its desktop app, over the data folder `client` opened. */
export const createServices: CreateServices = (client) => ({
	capture: createMicrophoneDevice({ device: client, recorder }),
	ai: madeOnce(),
	openChoices: () => createBrowserModelChoices('whispering'),
	connectionsNote:
		"A connection's key is kept in this computer's credential store and added by Whispering as a request leaves this computer, so any endpoint works, including one on this computer or your network. Epicenter's models go through Epicenter's API.",
	preferences: localPreferences,
});
