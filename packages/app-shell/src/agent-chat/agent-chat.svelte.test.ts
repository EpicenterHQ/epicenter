/**
 * Conversation-opening tests for the shared chat registry.
 *
 * The behavior under test is the session boundary: a caller that composes a
 * conversation (Vocab's Practice) gets a titled conversation of its own, and
 * its opening turn lands there rather than in whatever conversation happened to
 * be active. The blank-conversation path every "New Chat" button takes must be
 * untouched by the argument that makes this possible.
 *
 * These are plain bun tests with no Svelte runtime, so the runes are shimmed to
 * their non-reactive meaning (the pattern `packages/svelte-utils` tests use) and
 * every assertion reads imperatively. That is enough here: the question is where
 * a write went, not whether a view recomputed.
 */

import { expect, mock, test } from 'bun:test';

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(compute: () => TValue) => compute() },
);

mock.module('svelte/reactivity', () => ({
	SvelteMap: Map,
	// `fromTable` installs its subscription only from inside a Svelte effect;
	// these tests drive the registry directly through its own table subscription.
	createSubscriber: () => () => {},
}));

// The engine is the one collaborator that would reach the network. An empty
// stream ends the turn immediately and, because an assistant message with no
// parts is not persistable, writes nothing: every message in a store below is a
// user turn somebody deliberately sent.
mock.module('@epicenter/client', () => ({
	createOpenAiAgentEngine: () => async function* () {},
}));

import type { AgentMessage } from '@epicenter/agent';
import type { Conversation, ConversationsTable } from '@epicenter/chat';
import type { RowDocument } from '@epicenter/data';
import { createAgentChatState } from './agent-chat.svelte.js';

/** Let the registry's own async work (row documents, reconciliation) drain. */
const settle = () => Bun.sleep(1);

const DEFAULT_MODEL = 'test-model';

type MessageLog = {
	/** Every message written into this conversation's document, in write order. */
	readonly messages: AgentMessage[];
	texts(): string[];
};

function createFakeChat() {
	const rows = new Map<string, Conversation>();
	const listeners = new Set<() => void>();
	const documents = new Map<string, MessageLog>();
	const creates: Conversation[] = [];
	const updates: { id: string; patch: Partial<Conversation> }[] = [];
	let nextId = 0;

	const table = {
		async create(fields: Omit<Conversation, 'id'>) {
			const row = { id: `c${++nextId}`, ...fields };
			rows.set(row.id, row);
			creates.push(row);
			for (const listener of listeners) listener();
			return row;
		},
		async update(id: string, patch: Partial<Conversation>) {
			updates.push({ id, patch });
			const existing = rows.get(id);
			if (existing) rows.set(id, { ...existing, ...patch });
			return { data: rows.get(id), error: null };
		},
		async delete(id: string) {
			return rows.delete(id);
		},
		async get(id: string) {
			return { data: rows.get(id), error: null };
		},
		async scan() {
			return { rows: [...rows.values()], nonconforming: [] };
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as ConversationsTable;

	/** A row document that records writes instead of storing a CRDT. */
	function openConversationDocument(id: string): Promise<RowDocument> {
		const messages: AgentMessage[] = [];
		documents.set(id, {
			messages,
			texts: () =>
				messages.flatMap((message) =>
					message.parts.flatMap((part) =>
						part.type === 'text' ? [part.text] : [],
					),
				),
		});
		const handlers = new Set<() => void>();
		const map = {
			setAttr(_key: string, value: AgentMessage) {
				messages.push(value);
				for (const handler of handlers) handler();
			},
			attrEntries: () => messages.map((message) => [message.id, message]),
			observe: (handler: () => void) => handlers.add(handler),
			unobserve: (handler: () => void) => handlers.delete(handler),
		};
		return Promise.resolve({
			get: () => map,
			transact: <TValue>(run: () => TValue) => run(),
			whenDurable: async () => {},
			async [Symbol.asyncDispose]() {},
		} as unknown as RowDocument);
	}

	const chat = createAgentChatState({
		table,
		openConversationDocument,
		reportBackgroundError: (cause) => {
			throw cause;
		},
		connections: {
			resolveOrHosted: () => ({ baseUrl: 'http://test', apiKey: 'test' }),
			canServe: () => true,
		} as never,
		agent: {
			buildSystemPrompts: () => ['system'],
			defaultModel: DEFAULT_MODEL,
		},
	});

	return {
		chat,
		creates,
		updates,
		rows,
		/** The message log for one conversation, which must already be open. */
		document(id: string): MessageLog {
			const log = documents.get(id);
			if (!log) throw new Error(`No document was opened for ${id}`);
			return log;
		},
	};
}

/**
 * Boot the registry and return the conversation it lands the user in, with one
 * ordinary turn already in it. This is the "a topic conversation is open" state
 * every practice-session assertion is made against.
 */
async function bootWithActiveTopic() {
	const fake = createFakeChat();
	await settle();

	const topicId = fake.chat.activeConversationId;
	if (topicId === null) throw new Error('Boot left no active conversation');
	fake.chat.active?.sendMessage('what is the word for tea');
	await settle();
	expect(fake.document(topicId).texts()).toEqual(['what is the word for tea']);

	return { ...fake, topicId };
}

test('a blank conversation is unchanged: placeholder title, no opening turn', async () => {
	const { chat, creates, document } = await bootWithActiveTopic();
	const createdBefore = creates.length;

	const id = await chat.createConversation();

	expect(creates.slice(createdBefore)).toEqual([
		{
			id,
			title: 'New Chat',
			model: DEFAULT_MODEL,
			createdAt: expect.any(String),
			updatedAt: expect.any(String),
		},
	]);
	expect(document(id).messages).toEqual([]);
	expect(chat.activeConversationId).toBe(id);
});

test('a supplied title is written at creation, not derived from the first turn', async () => {
	const { chat, creates } = await bootWithActiveTopic();

	const id = await chat.createConversation({ title: 'Practice: 你好, 再见' });

	expect(creates.at(-1)?.title).toBe('Practice: 你好, 再见');
	expect(creates.at(-1)?.id).toBe(id);
});

test('a supplied title survives the opening turn', async () => {
	const { chat, updates, rows } = await bootWithActiveTopic();
	const opening = 'Using the entries below, write a short passage.';

	const id = await chat.createConversation({
		title: 'Practice: 你好, 再见',
		opening,
	});
	await settle();

	// The auto-title only ever replaces the blank placeholder, so the write the
	// opening turn triggers re-states the real title rather than the turn's text.
	const titled = updates.filter((update) => update.id === id);
	expect(titled.length).toBeGreaterThan(0);
	for (const update of titled) {
		expect(update.patch.title).toBe('Practice: 你好, 再见');
	}
	expect(rows.get(id)?.title).toBe('Practice: 你好, 再见');
	expect(rows.get(id)?.title).not.toContain(opening.slice(0, 20));
});

test('the opening turn lands in the new conversation, not the active one', async () => {
	const { chat, document, topicId } = await bootWithActiveTopic();
	const opening = 'Using the entries below, write a short passage.';

	const practiceId = await chat.createConversation({
		title: 'Practice: 你好',
		opening,
	});
	await settle();

	expect(practiceId).not.toBe(topicId);
	expect(document(practiceId).texts()).toEqual([opening]);
	// The topic conversation is exactly where the learner left it: the compiled
	// turn is permanent conversation memory, so leaking it here would steer that
	// thread for good.
	expect(document(topicId).texts()).toEqual(['what is the word for tea']);
	expect(chat.activeConversationId).toBe(practiceId);
});

test('the new conversation is only active once the create is awaited', async () => {
	const { chat, topicId } = await bootWithActiveTopic();

	const pending = chat.createConversation({
		title: 'Practice: 你好',
		opening: 'Using the entries below, write a short passage.',
	});

	// Reading `active` without awaiting still sees the previous conversation.
	// Sending the opening from the call site instead of from inside the create is
	// what used to put a practice turn in the wrong thread, or drop it entirely.
	expect(chat.activeConversationId).toBe(topicId);
	const practiceId = await pending;
	expect(chat.activeConversationId).toBe(practiceId);
});

test('a title with no opening opens a named conversation and sends nothing', async () => {
	const { chat, document } = await bootWithActiveTopic();

	const id = await chat.createConversation({ title: 'Practice: 你好' });
	await settle();

	expect(document(id).messages).toEqual([]);
});

test('a composed conversation carries the model forward like a blank one', async () => {
	const { chat, creates } = await bootWithActiveTopic();

	await chat.createConversation({ title: 'Practice: 你好' });

	expect(creates.at(-1)?.model).toBe(DEFAULT_MODEL);
});

// A composed opener names a conversation the user never typed, and the titled
// list is the only way back to a topic, so the title has to be correctable.
// That a real title then survives the next turn is the auto-title guard, already
// covered above; the runes here are shimmed to a single evaluation, so a handle
// cannot observe its own row change mid-test.
test('renaming a conversation writes the new title to its row', async () => {
	const { chat, rows } = await bootWithActiveTopic();

	const id = await chat.createConversation({ title: 'Practice: 你好, 再见' });
	await settle();
	const conversation = chat.active;
	if (!conversation) throw new Error('The new conversation has no handle');

	conversation.title = 'Tea vocabulary';
	await settle();

	expect(rows.get(id)?.title).toBe('Tea vocabulary');
});
