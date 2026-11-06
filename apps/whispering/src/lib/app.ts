/**
 * Whispering's capabilities, opened once for the page's life (ADR-0766),
 * each read through `reactive` here, once, under its own names. Every page,
 * component and module imports what it uses from here; product state
 * (Whispering and its library) is the app's own (`WhisperingApp`). Each
 * capability chooses where the page runs (ADR-0781); nothing here does.
 *
 * - `folder` is the one store: the signed-in person's `whispering`
 *   repository in a browser, which keeps nothing of it (ADR-0786), and the
 *   data folder in a Tauri window; memory under the `test` condition.
 * - `account` is the sign-in with Epicenter. In a browser it holds the
 *   repository and adds hosted transcription and AI; in a Tauri window the
 *   data folder needs none, and signing in adds only those: Epicenter, not
 *   the app, syncs the folder (ADR-0822).
 * - `ai` is every model this page reaches (ADR-0757), in the order the
 *   model picker lists them: Epicenter's hosted models through the account
 *   signed in now, the person's connected endpoints, then what runs on this
 *   computer (Ollama and LM Studio, and in a Tauri window transcription in
 *   this app's process, `speech`). Every entry is live, so sign-in and a
 *   connection added reach it without a new one. Nothing sends a request
 *   until the person asks.
 * - `choices` is this computer's model for each job, `'transcribe'` and
 *   `'chat'`.
 * - `settings` is this computer's settings, which `<WhenOpen>` connects to
 *   beside the folder: the model choices, the connections, the microphone
 *   and the shortcut override are read at once from then.
 * - `speech` is transcription in this app's process, null in a browser:
 *   the handle `ai` merges and Settings administers.
 * - `recorder` records from the microphone into `folder.audio`, as it
 *   records: the shell's in a Tauri window, the page's own in a browser.
 * - `shortcut` is the global shortcut, null in a browser.
 * - `connectionsRelayed` says whether the shell keeps each connection's key
 *   and sends its requests, which Settings tells the person.
 */
import { connectAccount } from '@epicenter/account';
import {
	customEndpoints,
	hosted,
	localServers,
	modelChoices,
	openAi,
} from '@epicenter/ai';
import { APPS } from '@epicenter/definition/site';
import { home, openFolder } from '@epicenter/folder';
import { settings as computer } from '@epicenter/local';
import { recorder as microphone } from '@epicenter/recorder';
import { reactive } from '@epicenter/svelte/reactive';
import { localSpeech } from '@epicenter/transcription';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import { whispering } from './contract.js';
import { createMicrophoneDevice } from './microphone.js';
import { openShortcut } from './shortcut.js';

const signIn = connectAccount({
	clientId: APPS.WHISPERING.id,
	api: APP_URLS.API,
	selfHosted: SELF_HOST_ORIGIN,
	// A timer must not navigate away in the middle of a recording.
	automaticRenewal: false,
});
const files = openFolder(
	whispering,
	home({ site: APPS.WHISPERING.url, account: signIn }),
);
const connections = customEndpoints();
const held = openShortcut(files);

export const account = reactive(signIn);
export const folder = reactive(files);
export const speech = localSpeech();
export const ai = reactive(
	openAi([hosted(signIn), connections, localServers(), speech]),
);
export const choices = reactive(modelChoices<'transcribe' | 'chat'>());
export const settings = reactive(computer);
export const recorder = createMicrophoneDevice({
	files: folder.audio,
	recorder: microphone,
});
export const shortcut = held && reactive(held);
export const connectionsRelayed = connections.relayed;
