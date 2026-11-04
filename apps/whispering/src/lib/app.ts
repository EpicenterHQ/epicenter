/**
 * Whispering's capabilities, opened once for the page's life (ADR-0766),
 * each read through `reactive` here, once, under its own names. Every page,
 * component and module imports what it uses from here; product state
 * (Whispering and its library) is the app's own (`WhisperingApp`).
 *
 * - `folder` is the one store of the build: this browser's storage on the
 *   web, for good, and the data folder on the desktop; memory under the
 *   `test` condition. It is never the account's: signing in grants
 *   capabilities, never storage (ADR-0700), so `openFolder` is given no
 *   account.
 * - `account` is the optional sign-in with Epicenter, for hosted
 *   transcription and AI alone.
 * - `ai` is every model this page reaches (ADR-0757), in the order the
 *   model picker lists them: Epicenter's hosted models through the account
 *   signed in now, the person's connected endpoints, then what runs on this
 *   computer. Every entry is live, so sign-in and a connection added reach
 *   it without a new one. Nothing sends a request until the person asks.
 * - `choices` is this computer's model for each job, `'transcribe'` and
 *   `'chat'`.
 * - `speech` is transcription in this app's process on the desktop, null on
 *   the web: the handle `ai` merges and Settings administers.
 * - `recorder` records from the microphone into `folder`, as it records.
 * - `shortcut` is the desktop's global shortcut, null on the web.
 */
import { customEndpoints, hosted, modelChoices, openAi } from '@epicenter/ai';
import { APPS } from '@epicenter/definition/site';
import { openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { localSpeech } from '@epicenter/transcription';
import { connectAccount } from '#platform/account';
import {
	localModelServers,
	microphone,
	openShortcut,
} from '#platform/computer';
import { whispering } from './contract.js';
import { createMicrophoneDevice } from './microphone.js';

const signIn = connectAccount();
const files = openFolder(whispering, { site: APPS.WHISPERING.url });
const held = openShortcut(files);

export const account = reactive(signIn);
export const folder = reactive(files);
export const speech = localSpeech();
export const ai = reactive(
	openAi([hosted(signIn), customEndpoints(), localModelServers(), speech]),
);
export const choices = reactive(modelChoices<'transcribe' | 'chat'>());
export const recorder = createMicrophoneDevice({ folder, recorder: microphone });
export const shortcut = held && reactive(held);
