/**
 * Vocab's capabilities, opened once for the page's life (ADR-0766): the
 * account, the folder, and where the tutor and dictation run, each read
 * through `reactive` here, once, under its own names. Every page, component
 * and module imports what it uses from here.
 *
 * The folder is the one store of the build: the web opens the signed-in
 * learner's `vocab` repository (this browser keeps none of the words or
 * chats, ADR-0700), and the desktop window opens the folder Vocab keeps them
 * in, whatever the account. Under the `test` condition it is a folder in
 * memory.
 *
 * The account is on both builds: the web's sign-in holds the repository and
 * adds the hosted models; the desktop's is optional and only adds the hosted
 * models.
 *
 * `ai` is every model Vocab can reach: Ollama and LM Studio on this computer
 * when they run, then Epicenter's hosted models (the tutor's and
 * dictation's) while the learner is signed in, then the endpoints the
 * learner connected on this device. Every entry is live: signing in or out,
 * and a connection added, edited or removed, reach the same `ai`. The
 * connections and the chosen model are this device's settings, not the
 * learner's data (`customEndpoints()` and `modelChoices()`: this browser's
 * storage on the web; on the desktop AppData's `connections.md` and
 * `models.md`, each key in the keychain and every request sent by the
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
import { APPS } from '@epicenter/definition/site';
import { home, openFolder } from '@epicenter/folder';
import { reactive } from '@epicenter/svelte/reactive';
import { connectAccount } from '#platform/account';
import { vocab } from './contract.js';
import { HOSTED_TUTOR, VOCAB_MODEL } from './data.js';

const signIn = connectAccount();

export const account = reactive(signIn);
export const folder = reactive(
	openFolder(vocab, home({ site: APPS.VOCAB.url, account: signIn })),
);

/** Every model Vocab can reach. `hosted` reads the account at every use. */
export const ai = reactive(
	openAi([
		localServers(),
		hosted(signIn, { models: [VOCAB_MODEL, HOSTED_TRANSCRIPTION_MODEL] }),
		customEndpoints(),
	]),
);

/**
 * The tutor's model on this device, kept by job (`'chat'`): Epicenter's
 * tutor model until the learner chooses another.
 */
export const choices = reactive(modelChoices<'chat'>({ chat: HOSTED_TUTOR }));
