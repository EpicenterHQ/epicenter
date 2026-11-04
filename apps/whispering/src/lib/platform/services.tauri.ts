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
 * - A connection the person saved is listed in AppData's `connections.md`
 *   and its key is in the credential store, both written through the shell
 *   (`createKeychainConnections` from `@epicenter/ai/tauri`). Its requests
 *   leave through the shell, which adds the key (`connection_fetch`), so the
 *   key never reaches this page and no endpoint needs to allow the window's
 *   origin.
 * - Ollama and LM Studio on this computer are reached through the same shell
 *   fetch with no key (`shellFetch`), since neither answers a `tauri://` page.
 * - Transcription on this computer runs in this app's process
 *   (`localSpeech()` from `@epicenter/transcription`).
 */

import { hosted, localServers } from '@epicenter/ai';
import { createBrowserModelChoices } from '@epicenter/ai/choices';
import { createKeychainConnections, shellFetch } from '@epicenter/ai/tauri';
import { openAppData } from '@epicenter/folder/tauri';
import { recorder } from '@epicenter/recorder/tauri';
import { localSpeech } from '@epicenter/transcription';
import { createMicrophoneDevice } from '../microphone.js';
import { localPreferences } from '../microphone-preference.js';
import { whisperingSettings } from '../settings.tauri.js';
import { getAuth } from './auth.tauri.js';
import type { CreateServices } from './types.js';

/** Whispering's services in its desktop app, over the data folder `client` opened. */
export const createServices: CreateServices = (client) => {
	const local = [...localServers({ fetch: shellFetch }), localSpeech()].filter(
		(endpoint) => endpoint !== null,
	);
	return {
		capture: createMicrophoneDevice({ device: client, recorder }),
		endpoints: {
			hosted() {
				const { state } = getAuth();
				return hosted(state.status === 'signed-out' ? null : state.account);
			},
			local,
			async openConnections() {
				const opened = await openAppData(whisperingSettings);
				if (opened.error !== null)
					throw new Error(
						`Whispering's connections could not be opened: ${opened.error.message}`,
						{ cause: opened.error },
					);
				const connections = createKeychainConnections({
					file: opened.data.connections,
				});
				await connections.ready;
				return connections;
			},
			openChoices: () => createBrowserModelChoices('whispering'),
			note: "A connection's key is kept in this computer's credential store and added by Whispering as a request leaves this computer, so any endpoint works, including one on this computer or your network. Epicenter's models go through Epicenter's API.",
		},
		preferences: localPreferences,
	};
};
