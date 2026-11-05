/**
 * Vocab's capabilities, opened once for the page's life (ADR-0766): the
 * account, the folder, and where the tutor and dictation run, each read
 * through `reactive` here, once, under its own names. Every page, component
 * and module imports what it uses from here.
 *
 * In a browser the folder is the signed-in learner's `vocab` repository
 * (this browser keeps none of the words or chats, ADR-0700); in a Tauri
 * window it is the folder Vocab keeps them in on this computer, whatever the
 * account. Under the `test` condition it is a folder in memory.
 *
 * The account is there in both: in a browser its sign-in holds the
 * repository and adds the hosted models and the learner's profile; in a
 * Tauri window it is optional, adds them, and syncs the folder (ADR-0785).
 *
 * `ai` is every model Vocab can reach: Ollama and LM Studio on this computer
 * when they run, then Epicenter's hosted models (the tutor's and
 * dictation's) while the learner is signed in, then the endpoints the
 * learner connected on this computer. Every entry is live: signing in or
 * out, and a connection added, edited or removed, reach the same `ai`. The
 * connections and the chosen model are this computer's settings, not the
 * learner's data (`customEndpoints()` and `modelChoices()` in
 * `connections.md` and `models.md`: this browser's storage in a browser,
 * AppData in a Tauri window, where the shell holds each key and sends every
 * request), and none of this decides where words and chats are kept.
 */
import { connectAccount, openProfile } from '@epicenter/account';
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
import { settings as computer } from '@epicenter/local';
import { reactive } from '@epicenter/svelte/reactive';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import { vocab } from './contract.js';
import { HOSTED_TUTOR, VOCAB_MODEL } from './data.js';

const signIn = connectAccount({
	clientId: APPS.VOCAB.id,
	api: APP_URLS.API,
	selfHosted: SELF_HOST_ORIGIN,
});

export const account = reactive(signIn);
/** Who is signed in, by name and email, which the account menu shows. */
export const profile = openProfile(signIn);
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
 * The tutor's model on this computer, kept by job (`'chat'`): Epicenter's
 * tutor model until the learner chooses another.
 */
export const choices = reactive(modelChoices<'chat'>({ chat: HOSTED_TUTOR }));

/**
 * This computer's settings, which `<WhenOpen>` connects to beside the
 * folder: the connections and the chosen model are read at once from then.
 */
export const settings = reactive(computer);
