import type { Account } from '@epicenter/account';
import { type Endpoint, hosted, localServers, openAi } from '@epicenter/ai';
import type {
	AiConnectionSnapshot,
	AiConnections,
} from '@epicenter/ai/connections';
import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/ai/providers';
import { fromAi } from '@epicenter/ai/svelte';
import { extractErrorMessage } from 'wellcrafted/error';
import { openConnections } from '#platform/connections';
import { VOCAB_MODEL } from './data.js';

/** The tutor's model when the learner has chosen none: Epicenter's, once signed in. */
export const HOSTED_TUTOR = { endpoint: 'hosted', model: VOCAB_MODEL };

/**
 * Where the tutor and dictation can run, merged in the order the picker
 * lists them: Ollama and LM Studio on this computer when they run, then
 * Epicenter's hosted models once signed in (the tutor's model and
 * dictation's), then the endpoints the learner connected on this device.
 *
 * The connected endpoints are this device's settings, not the learner's data
 * (`#platform/connections`: this browser's storage on the web; on the
 * desktop the AppData root's `connections.md`, each key in the keychain and
 * every request sent by the shell). They are the same signed in and out.
 * When they cannot be opened, `problem` says why and the other endpoints
 * still work; none of this decides where words and chats are kept.
 *
 * `current` merges again whenever a connection is added, edited or removed.
 */
export function createVocabAi(
	account: Account | undefined,
	{
		open = openConnections,
		servers = localServers(),
	}: {
		open?: () => Promise<AiConnections>;
		servers?: readonly Endpoint[];
	} = {},
) {
	let connections = $state.raw<AiConnections | null>(null);
	let records = $state.raw<readonly AiConnectionSnapshot[]>([]);
	let problem = $state.raw<string | null>(null);
	let unsubscribe: (() => void) | undefined;
	let closed = false;
	const ready = open().then(
		(opened) => {
			if (closed) return opened.close();
			connections = opened;
			unsubscribe = opened.subscribe((next) => {
				records = next;
			});
		},
		(cause) => {
			problem = extractErrorMessage(cause);
		},
	);
	const learnerHosted = hosted(account, {
		models: [VOCAB_MODEL, HOSTED_TRANSCRIPTION_MODEL],
	});
	const current = $derived(
		fromAi(
			openAi([
				servers,
				learnerHosted,
				...records.map((record) => connections?.endpoint(record)),
			]),
		),
	);
	return {
		/** Every endpoint merged now; tracks in Svelte. */
		get current() {
			return current;
		},
		/** The learner's saved connections, once opened. */
		get connections() {
			return connections;
		},
		/** Why the saved connections could not be opened, if they could not. */
		get problem() {
			return problem;
		},
		/** Settles once the saved connections opened or failed to. */
		ready: ready.then(() => {}),
		async close() {
			closed = true;
			unsubscribe?.();
			await connections?.close();
		},
	};
}
export type VocabAi = ReturnType<typeof createVocabAi>;
