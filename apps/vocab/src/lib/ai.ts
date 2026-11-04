/**
 * Where the tutor and dictation run, made once for the page: Ollama and LM
 * Studio on this computer when they run, then Epicenter's hosted models
 * (the tutor's and dictation's) while the learner is signed in, then the
 * endpoints the learner connected on this device.
 *
 * Every entry is live. Signing in or out, and a connection added, edited or
 * removed, reach the same `ai`; nothing merges again. The connections are
 * this device's settings, not the learner's data (`customEndpoints()`:
 * this browser's storage on the web; on the desktop the AppData root's
 * `connections.md`, each key in the keychain and every request sent by the
 * shell), and none of this decides where words and chats are kept.
 */
import {
	customEndpoints,
	hosted,
	localServers,
	modelChoices,
	openAi,
} from '@epicenter/ai';
import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/ai/providers';
import { reactive } from '@epicenter/svelte/reactive';
import { account } from '#platform/auth';
import { HOSTED_TUTOR, VOCAB_MODEL } from './data.js';

/** Every model Vocab can reach, read through `reactive`. */
export const ai = reactive(
	openAi([
		localServers(),
		hosted(account, { models: [VOCAB_MODEL, HOSTED_TRANSCRIPTION_MODEL] }),
		customEndpoints(),
	]),
);

/**
 * The tutor's model on this device, kept by job (`'chat'`): Epicenter's
 * tutor model until the learner chooses another. A device setting, not the
 * learner's data (this browser's storage on the web, AppData's `models.md`
 * on the desktop).
 */
export const choices = reactive(modelChoices<'chat'>({ chat: HOSTED_TUTOR }));
