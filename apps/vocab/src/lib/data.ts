import {
	defineStore,
	defineTable,
	field,
	plainText,
	type RowOf,
} from '@epicenter/app';
import type { DeclaredData } from '@epicenter/app/store';
import { APPS } from '@epicenter/constants/apps';
/**
 * Vocab's inert local and personal store declarations. Isomorphic: no IndexedDB,
 * WebSockets, Svelte state, or browser APIs.
 *
 * The app imports it as `$lib/data`, which is the one specifier there is for
 * it. It used to be the target of a `"."` package export as well, so the same
 * file arrived as `@epicenter/vocab` in some modules and by relative path in
 * others; nothing outside the app ever imported the package, so the export was
 * a second name for a local file and nothing else. The shapes here are the wire contract for
 * sync; forking a field shape breaks sync compatibility with peers running the
 * canonical workspace.
 *
 * `AppBoot` captures the Account and opens both stores only after the primary
 * route mounts.
 */

import { conversationsTable, messagesTable } from '@epicenter/chat';
import type { ServableModel } from '@epicenter/constants/ai-providers';

/**
 * Vocab runs a single model. It is an app constant, not a per-conversation
 * choice; the canonical conversations table requires a `model`, so Vocab writes
 * this constant on every row and never offers a per-conversation pick. The
 * client also reads it when it answers over the OpenAI-compatible stream.
 */
export const VOCAB_MODEL = 'gemini-3.5-flash' satisfies ServableModel;

/**
 * The multilingual tutor system prompt every Vocab answer is generated under. An
 * app constant like {@link VOCAB_MODEL}: the client passes it to the Epicenter
 * provider when it answers. It lives in this dep-free contract so the prompt is
 * single-homed, read by whichever module builds the stream.
 *
 * The tutor writes plain text only: readings (pinyin, romaji, ...) are a
 * client-side render view added over clean text, never baked into the answer.
 * Keeping the message clean protects it as conversation memory (it is fed back
 * to the model on later turns) and keeps saved entries verbatim (ADR-0102).
 */
export const VOCAB_SYSTEM_PROMPT = `You are a multilingual language tutor. The user is learning a language; answer in that language alongside English, and adapt to whichever language they are studying: infer it from what they ask, and follow if they switch or mix languages.

Guidelines:
- Use English for explanations, transitions, and meta-commentary.
- Use the language being studied for vocabulary, example sentences, and conversational phrases.
- Write plain text only. Never add pronunciation guides, phonetic readings, or romanization (no pinyin, romaji, or transliteration): the client renders readings above the text automatically.
- When teaching vocabulary, present the studied-language word naturally inline inside an English sentence, e.g. "The word for 'to study' is used like this: ...".
- For example sentences, write them in the studied language, then explain in English.
- Adjust difficulty based on context clues from the user's questions.
- Be conversational and encouraging.`;

/**
 * The entries table: the user-curated store of language units of any length
 * (words, phrases, chengyu) captured by selection. One pool, no decks.
 * `stage` is the one acquisition dial (new: saved because you did not know
 * it; understood: you comprehend it; usable: you can produce it). `note` is
 * human-owned: no code path machine-writes it.
 */
const entriesTable = defineTable({
	fields: {
		text: field.string(),
		note: field.string(),
		stage: field.select(['new', 'understood', 'usable']),
		// Validation-only rather than `string.date.parse`: a parsing form would hand
		// back a `Date` that could not round-trip through the projection.
		createdAt: field.instant(),
	},
	body: plainText(),
});

/**
 * Device-only Vocab state: chat history and presentation settings. Practice
 * copies selected entry text into a local conversation; it does not maintain
 * a reference from that conversation to account-backed entries.
 *
 * `showReadings` is `kv` rather than a `settings` row, and that is a
 * correctness fix rather than tidiness. It used to be a row at a chosen id, so
 * two devices writing their settings on their own boot paths each minted a
 * container at that address and map LWW discarded one along with everything in
 * it. A KV root is addressed by its name, so independent minting converges
 * (ADR-0213). It is read from the DEVICE document in every generation: how this
 * screen renders is a fact about this screen, not portable work (ADR-0233).
 */
export const vocabLocalDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab on this device',
	kv: {
		/** Readings render by default. */
		showReadings: field.boolean(),
	},
	tables: {
		conversations: conversationsTable,
		messages: messagesTable,
	},
});

/** Account-backed vocabulary entries follow the learner across devices. */
export const vocabDefinition = defineStore({
	id: APPS.VOCAB.id,
	title: 'Vocab',
	kv: {},
	tables: {
		entries: entriesTable,
	},
});

/** The typed view of Vocab's account-backed entries. */
export type VocabData = DeclaredData<typeof vocabDefinition>;

/** The typed view of this device's chat and settings. */
export type VocabLocalData = DeclaredData<typeof vocabLocalDefinition>;

/** One entry row. Row ids are runtime-minted, so the runtime owns `id`. */
export type Entry = RowOf<typeof entriesTable>;
