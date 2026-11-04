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
import { customEndpoints, hosted, localServers, openAi } from '@epicenter/ai';
import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/ai/providers';
import { fromAi } from '@epicenter/ai/svelte';
import { account } from '#platform/auth';
import { VOCAB_MODEL } from './data.js';

/** Every model Vocab can reach, as Svelte state. */
export const ai = fromAi(
	openAi([
		localServers(),
		hosted(account, { models: [VOCAB_MODEL, HOSTED_TRANSCRIPTION_MODEL] }),
		customEndpoints(),
	]),
);
