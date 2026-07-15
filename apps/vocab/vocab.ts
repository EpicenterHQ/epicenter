/**
 * Vocab workspace contract: id, branded types, tables, kv, and the workspace
 * factory. Isomorphic: no IndexedDB, WebSockets, Svelte state, or browser APIs.
 *
 * Distribution: this file is the `@epicenter/vocab` package root file
 * (the target of the package's `"."` export). The browser entrypoint imports the
 * schema from here and composes runtime-specific attachments around it. The table
 * and KV shapes here are the wire contract for sync; forking a column shape
 * breaks sync compatibility with peers running the canonical schema.
 *
 * Composition lives elsewhere:
 *  - `apps/vocab/vocab.browser.ts`
 *      → `openVocabBrowser({ auth })`
 */

import type { ServableModel } from '@epicenter/constants/ai-providers';
import type { AgentMessage } from '@epicenter/workspace/agent';
import {
	defineKv,
	defineTable,
	field,
	type Id,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import type { Brand } from 'wellcrafted/brand';

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
 * The model Vocab dictates through. Pinned to OpenAI's `whisper-1`, the one
 * model the hosted speech-to-text gateway serves: it returns the `duration` the
 * per-minute meter reads, which the `gpt-4o-transcribe` models drop. An app
 * constant like {@link VOCAB_MODEL}: transcription is a stateless service, so
 * Vocab names its own model rather than borrow another app's. A user who points
 * a device connection at their own OpenAI key serving `whisper-1` dictates
 * through that instead (the connection registry resolves it first).
 */
export const VOCAB_STT_MODEL = 'whisper-1';

// ─────────────────────────────────────────────────────────────────────────────
// Message Model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A complete chat message: the unit Vocab persists. Each finished message is
 * written once, whole, as one JSON blob in the conversation's LWW store keyed by
 * its message id (ADR-0046/0047), the moment a turn finishes.
 *
 * It is the shared {@link AgentMessage} so Vocab rides the one client agent loop
 * (`@epicenter/workspace/agent`). Vocab is capability-free, so every message is
 * a single text part, but the parts-array shape is the same one a tool agent
 * fills with tool-call and tool-result parts.
 */
export type VocabMessage = AgentMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Entries
// ─────────────────────────────────────────────────────────────────────────────

/** Framework-allocated entry row ID. */
export type EntryId = Id & Brand<'EntryId'>;

/**
 * The entries table: the user-curated store of language units of any length
 * (words, phrases, chengyu) captured by selection. One pool, no decks.
 * `stage` is the one acquisition dial (new: saved because you did not know
 * it; understood: you comprehend it; usable: you can produce it). `note` is
 * human-owned: no code path machine-writes it.
 */
export const entriesTable = defineTable({
	fields: {
		id: field.id<EntryId>(),
		text: field.string(),
		note: field.string(),
		stage: field.select(['new', 'understood', 'usable']),
		createdAt: field.instant(),
	},
});

/** One entry row. */
export type Entry = RowFor<typeof entriesTable>;

/** Synchronized reading-overlay preference for Vocab version 1. */
export const showReadings = defineKv(field.boolean(), () => true);
