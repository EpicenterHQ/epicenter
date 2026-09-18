import {
	ContentError,
	defineTable,
	field,
	type RowOf,
} from '@epicenter/app/definition';
import type { TypedTableHandle } from '@epicenter/app/store';
import * as Y from '@y/y';
/**
 * The canonical conversation shape every chat surface shares: the fields a
 * `conversations` table declares, the id vocabulary, its content codec, and the
 * adapter that presents one conversation's message field as the agent loop's
 * store.
 *
 * Inert, and deliberately so. Nothing here opens a document, mints an address,
 * or knows which document a conversation lives in. An application splices
 * {@link conversationsTable} into its own workspace under its own id,
 * opens its own database document (device or account, ADR-0233), and hands the row's
 * `content` node to {@link createAgentMessageStore}. Vocab has always worked this
 * way and said so; the `chatLens` that used to sit beside the table was a
 * declaration no application ever bound, kept alive by its own test, and a
 * standalone declaration is a standalone document, which is exactly what a
 * sub-feature of an application must not be.
 */

import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
/** Store handles and inert schema vocabulary have separate entrypoints in App. */

import type { Brand } from 'wellcrafted/brand';
import { Err, Ok, type Result } from 'wellcrafted/result';

export type ConversationId = string & Brand<'ConversationId'>;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

/**
 * The fields a conversation row carries, as closed descriptors in a data
 * definition (ADR-0213).
 *
 * Spliced into an application's own workspace rather than published as one,
 * because a table root is addressed by its NAME inside whichever document holds
 * it: two workspaces opened over one store share `conversations` whatever
 * namespaces they declare. So the shape is the reusable thing, and the
 * id is the application.s.
 *
 * @example
 * ```ts
 * export const vocabDefinition = defineApp({
 *   id: 'so.epicenter.vocab',
 *   tables: {
 *     conversations: conversationsTable,
 *     entries: entriesTable,
 *   },
 * });
 * ```
 */
export const conversationsTable = defineTable({
	title: field.string(),
	model: field.string(),
	// Validation-only rather than `string.date.parse`: a field has to be one
	// type through the CRDT attribute, the projection column and the row
	// alike, and a parsing form would hand back a `Date` that could not
	// round-trip.
	createdAt: field.instant(),
	updatedAt: field.instant(),
	/**
	 * The conversation's finished messages, as a keyed log (ADR-0295, ADR-0296).
	 *
	 * NOT text, and not a sequence at all: the entries live in the node's
	 * ATTRIBUTES, keyed by message id. `plainText()` would be silent data loss
	 * here, because `toString` renders attributes and `insert` takes the
	 * rendering back as one literal string that prints identically. Only this
	 * package knows what a conversation's node means, which is why the codec is
	 * declared here rather than defaulted.
	 *
	 * One entry per line of a pretty-printed array, which is what makes a diff
	 * of two exports legible.
	 *
	 * The node is minted with the row and never again, which removes the race a
	 * name-addressed root used to close: a nested node is addressed by the
	 * struct that created it, so two devices minting one would lose a subtree,
	 * and only the creating device ever mints this.
	 */
	content: {
		encode: (node: Y.Type) =>
			JSON.stringify(
				[...node.attrEntries()].map(([key, val]) => ({
					key: String(key),
					val,
				})),
				null,
				2,
			),
		decode: (text: string): Result<Y.Type, ContentError> => {
			// Built here and handed back (ADR-0296, amended). `create` integrates
			// it in the transaction that mints the row; nothing reads it before
			// then, because a detached node reads as empty until it is integrated.
			const messages = new Y.Type();
			const entries = messageEntries(text);
			if (entries.error !== null) return Err(entries.error);
			for (const entry of entries.data) messages.setAttr(entry.key, entry.val);
			return Ok(messages);
		},
		/**
		 * The log this node already holds, made to say what the file says
		 * (ADR-0337).
		 *
		 * Attributes, not a sequence: this node's content is entirely in its
		 * keys, so a `delete(0, length)` would clear nothing and leave every
		 * message where it was. That is why `rewrite` is the codec's verb and
		 * not the platform's.
		 *
		 * Keys the file no longer names are removed, so a person who deleted a
		 * message from the file gets a conversation without it rather than one
		 * where the deletion silently did nothing.
		 */
		rewrite: (node: Y.Type, text: string): Result<void, ContentError> => {
			const entries = messageEntries(text);
			if (entries.error !== null) return Err(entries.error);
			const named = new Set(entries.data.map((entry) => entry.key));
			for (const key of [...node.attrKeys()]) {
				if (!named.has(String(key))) node.deleteAttr(key as never);
			}
			for (const entry of entries.data) node.setAttr(entry.key, entry.val);
			return Ok(undefined);
		},
	},
});

/**
 * One file's body read back as the log it encodes, or why it is not one.
 *
 * Shared by `decode` and `rewrite` so the two directions agree on what a
 * message log is: a codec whose reader and rewriter disagreed would accept a
 * file into a new row and refuse the same file into an existing one.
 */
function messageEntries(
	text: string,
): Result<{ key: string; val: unknown }[], ContentError> {
	if (text.trim() === '') return Ok([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		return ContentError.Unreadable({
			reason: 'the message log is not JSON',
			cause,
		});
	}
	if (!Array.isArray(parsed)) {
		return ContentError.Unreadable({
			reason: 'the message log is not an array of entries',
		});
	}
	const entries: { key: string; val: unknown }[] = [];
	for (const entry of parsed as { key?: unknown; val?: unknown }[]) {
		if (typeof entry?.key !== 'string') {
			return ContentError.Unreadable({
				reason: 'a message entry carries no id',
			});
		}
		entries.push({ key: entry.key, val: entry.val });
	}
	return Ok(entries);
}

/** One conversation row, as a read hands it back. */
export type Conversation = RowOf<typeof conversationsTable>;

/** The bound `conversations` table handle, whichever document holds it. */
export type ConversationsTable = TypedTableHandle<typeof conversationsTable>;

/**
 * Present one conversation's `content` node as the agent loop's by-id store.
 *
 * An adapter and nothing more: it opens nothing and releases nothing. The type
 * is live on the database's one document (ADR-0295), so its lifetime is the
 * row's; durability is the store's write-behind and propagation is the
 * ordinary transport.
 *
 * @param messages The row's `content` node, from `table.get(id)?.content`.
 */
export function createAgentMessageStore(messages: Y.Type): AgentMessageStore {
	return {
		set(key, value) {
			messages.setAttr(key, value);
		},
		*entries() {
			for (const [key, val] of messages.attrEntries()) {
				yield { key: String(key), val: val as AgentMessage };
			}
		},
		observe(handler) {
			messages.observe(handler);
			return () => messages.unobserve(handler);
		},
		// Nothing to release. The loop still calls it, because a store backed by
		// something with a lifetime would need it; this one is a view onto a type
		// the application's document already holds.
		[Symbol.dispose]() {},
	};
}
