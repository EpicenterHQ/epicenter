/**
 * Canonical conversation domain and record Lens.
 *
 * Each product binds this Lens through its environment-owned record runtime.
 * Finished messages live in the row-owned Yjs 14 document under one `messages`
 * map; live turns remain client state.
 */

import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
import {
	defineLens,
	defineTable,
	type RecordTableLens,
	type RowDocument,
	type RowFor,
} from '@epicenter/data/record';
import { field } from '@epicenter/field';
import type { Brand } from 'wellcrafted/brand';

export type ConversationId = string & Brand<'ConversationId'>;

export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

export const conversationsTable = defineTable({
	title: 'Conversations',
	fields: {
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
	optional: [],
});

/** Pure JSON interpretation of the canonical Chat namespace. */
export const chatLens = defineLens({
	namespace: 'so.epicenter.chat',
	title: 'Chat',
	description: 'Conversations and their finished messages.',
	collections: { conversations: conversationsTable },
});

export type Conversation = RowFor<typeof conversationsTable>;

export type ConversationsTable = RecordTableLens<
	typeof conversationsTable,
	never,
	unknown
>;

export type AgentMessageDocumentStore = AgentMessageStore & {
	/** Wait for every message write issued before this call to reach local storage. */
	whenDurable(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Bind the agent loop's by-id store to one canonical row document. */
export function createAgentMessageDocumentStore(
	document: RowDocument,
): AgentMessageDocumentStore {
	const messages = document.get('messages');
	let disposed = false;
	let disposal: Promise<void> | undefined;
	const requireOpen = () => {
		if (disposed) throw new Error('Agent message store is disposed');
	};

	return {
		set(key, value) {
			requireOpen();
			document.transact(() => messages.setAttr(key, value));
		},
		*entries() {
			requireOpen();
			for (const [key, val] of messages.attrEntries()) {
				yield { key: String(key), val: val as AgentMessage };
			}
		},
		observe(handler) {
			requireOpen();
			messages.observe(handler);
			return () => messages.unobserve(handler);
		},
		whenDurable() {
			requireOpen();
			return document.whenDurable();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			disposal = document[Symbol.asyncDispose]();
		},
		async [Symbol.asyncDispose]() {
			if (!disposed) {
				disposed = true;
				disposal = document[Symbol.asyncDispose]();
			}
			await disposal;
		},
	};
}
