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
 *
 * The fake table is synchronous, because the real one is: rows come back from a
 * store already in memory. The only thing still awaited is the agent loop's
 * own turn.
 */

import { expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import type { OpenAiTurnContext } from '@epicenter/client';
let probeEngine: ((data: () => OpenAiTurnContext) => Promise<void>) | undefined;

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
	createSubscriber: () => () => undefined,
}));

// The engine is the one collaborator that would reach the network. An empty
// stream ends the turn immediately and, because an assistant message with no
// parts is not persistable, writes nothing: every message in a store below is a
// user turn somebody deliberately sent.
mock.module('@epicenter/client', () => ({
	createOpenAiAgentEngine: ({ data }: { data: () => OpenAiTurnContext }) =>
		async function* () {
			await probeEngine?.(data);
		},
}));

import type { AgentMessage } from '@epicenter/agent';
import type { Conversation, ConversationsTable, MessagesTable } from '@epicenter/chat';
import { Ok } from 'wellcrafted/result';
import { createAgentChatState } from './agent-chat.svelte.js';

/** Let the agent loop's turn finish. */
const settle = () => Bun.sleep(1);

const DEFAULT_MODEL = 'test-model';
const ACCOUNT_KEY = '["test-authority","test-principal"]';

type MessageLog = {
	/** Every message written as a row for this conversation, in write order. */
	readonly messages: AgentMessage[];
	texts(): string[];
};

function createFakeChat(withOtherAccount = false) {
	const rows = new Map<string, Conversation>();
	if (withOtherAccount) {
		rows.set('other-account', {
			id: 'other-account',
			accountKey: '["test-authority","other-principal"]',
			title: 'Private to another account',
			model: DEFAULT_MODEL,
			createdAt: '2026-09-24T00:00:00.000Z' as Conversation['createdAt'],
			updatedAt: '2026-09-24T00:00:00.000Z' as Conversation['updatedAt'],
		});
	}
	const listeners = new Set<() => void>();
	const messageRows = new Map<string, {
		id: string;
		conversationId: string;
		messageId: string;
		message: AgentMessage;
	}>();
	const messageListeners = new Set<() => void>();
	const creates: Conversation[] = [];
	const updates: { id: string; patch: Partial<Conversation> }[] = [];
	let nextId = 0;

	const announce = () => {
		for (const listener of listeners) listener();
	};

	const table = {
		create(fields: Omit<Conversation, 'id'>) {
			const row = { id: `c${++nextId}`, ...fields };
			rows.set(row.id, row);
			creates.push(row);
			announce();
			return row;
		},
		update(id: string, patch: Partial<Conversation>) {
			updates.push({ id, patch });
			const existing = rows.get(id);
			if (existing) rows.set(id, { ...existing, ...patch });
			return Ok(undefined);
		},
		delete(id: string) {
			const existed = rows.delete(id);
			announce();
			return existed;
		},
		get(id: string) {
			return rows.get(id);
		},
		get rows() {
			return [...rows.values()];
		},
		get nonconforming() {
			return [];
		},
		watch: () => () => undefined,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as ConversationsTable;
	const messages = {
		create(fields: { conversationId: string; messageId: string; message: AgentMessage }) {
			const row = { id: `m${++nextId}`, ...fields };
			messageRows.set(row.id, row);
			for (const listener of messageListeners) listener();
			return row;
		},
		update(id: string, patch: { message: AgentMessage }) {
			const row = messageRows.get(id);
			if (row) messageRows.set(id, { ...row, ...patch });
			for (const listener of messageListeners) listener();
			return Ok(undefined);
		},
		delete(id: string) {
			messageRows.delete(id);
			for (const listener of messageListeners) listener();
		},
		get rows() {
			return [...messageRows.values()];
		},
		subscribe(listener: () => void) {
			messageListeners.add(listener);
			return () => messageListeners.delete(listener);
		},
	} as unknown as MessagesTable;

	const targets = new Map<string, { connectionId: string; model: string }>();
	const clients = new Map([
		['first-id', new OpenAI({ baseURL: 'http://first/v1', apiKey: 'test' })],
		['second-id', new OpenAI({ baseURL: 'http://second/v1', apiKey: 'test' })],
	]);
	const chat = createAgentChatState({
		table,
		messages,
		transact: (run) => run(),
		accountKey: ACCOUNT_KEY,
		reportBackgroundError: (cause) => {
			throw cause;
		},
		selections: {
			get: (scope: string) => targets.get(scope) ?? null,
			set: (scope: string, target: { connectionId: string; model: string }) => {
				targets.set(scope, target);
			},
			onChange: () => () => undefined,
			[Symbol.dispose]() {},
		},
		catalog: {
			accountId: 'first-id',
			resolve: (target: { connectionId: string; model: string } | null) => {
				const client = target && clients.get(target.connectionId);
				return client && target
					? { client, model: target.model, source: 'custom' }
					: null;
			},
		} as never,
		agent: {
			buildSystemPrompts: () => ['system'],
			defaultModel: DEFAULT_MODEL,
		},
	});

	return {
		chat,
		targets,
		creates,
		updates,
		rows,
		messageRows,
		/** The message log for one conversation, which must already exist. */
		document(id: string): MessageLog {
			if (!rows.has(id)) throw new Error(`No conversation exists at ${id}`);
			const log = [...messageRows.values()]
				.filter((row) => row.conversationId === id)
				.map((row) => row.message);
			return {
				messages: log,
				texts: () => log.flatMap((message) =>
					message.parts.flatMap((part) => part.type === 'text' ? [part.text] : []),
				),
			};
		},
	};
}

test('deleting a conversation removes its finished message rows', async () => {
	const { chat, topicId, messageRows } = await bootWithActiveTopic();
	expect([...messageRows.values()].some((row) => row.conversationId === topicId)).toBe(true);
	chat.active?.delete();
	expect([...messageRows.values()].some((row) => row.conversationId === topicId)).toBe(false);
});

test('a device conversation from another account is not opened', () => {
	const { chat, rows } = createFakeChat(true);
	expect(rows.has('other-account')).toBe(true);
	expect(chat.conversations.some((conversation) => conversation.id === 'other-account')).toBe(false);
	expect(chat.activeConversationId).not.toBe('other-account');
});

/**
 * Boot the registry and return the conversation it lands the user in, with one
 * ordinary turn already in it. This is the "a topic conversation is open" state
 * every practice-session assertion is made against.
 */
async function bootWithActiveTopic() {
	const fake = createFakeChat();
	// Boot's conversation lands once its document's open resolves.
	await settle();

	const topicId = fake.chat.activeConversationId;
	if (topicId === null) throw new Error('Boot left no active conversation');
	fake.targets.set(topicId, { connectionId: 'first-id', model: DEFAULT_MODEL });
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
			accountKey: ACCOUNT_KEY,
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

test('an unavailable target prevents programmatic sends from writing a user turn', async () => {
	const fake = createFakeChat();
	const active = fake.chat.active!;
	fake.targets.delete(active.id);
	active.sendMessage('must not leave this device');
	await settle();
	expect(fake.document(active.id).texts()).toEqual([]);
	fake.chat[Symbol.dispose]();
});

test('a new conversation carries the explicit connection choice', () => {
	const fake = createFakeChat();
	const active = fake.chat.active!;
	fake.targets.set(active.id, {
		connectionId: 'second-id',
		model: active.model,
	});
	const next = fake.chat.createConversation();
	expect(fake.targets.get(next)).toEqual({
		connectionId: 'second-id',
		model: active.model,
	});
	fake.chat[Symbol.dispose]();
});

test('a practice opening remains a draft when its inherited connection is unavailable', () => {
	const fake = createFakeChat();
	fake.targets.delete(fake.chat.active!.id);
	const id = fake.chat.createConversation({
		title: 'Practice',
		opening: 'Practice these words',
	});
	expect(fake.chat.active!.inputValue).toBe('Practice these words');
	expect(fake.document(id).texts()).toEqual([]);
	fake.chat[Symbol.dispose]();
});

test('a run retains its captured destination across engine steps', async () => {
	const started = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const seen: string[] = [];
	probeEngine = async (data) => {
		seen.push(data().client.baseURL);
		started.resolve();
		await resume.promise;
		seen.push(data().client.baseURL);
		finished.resolve();
	};
	const fake = createFakeChat();
	try {
		const active = fake.chat.active!;
		fake.targets.set(active.id, {
			connectionId: 'first-id',
			model: active.model,
		});
		active.sendMessage('start');
		await started.promise;
		fake.targets.set(active.id, {
			connectionId: 'second-id',
			model: active.model,
		});
		resume.resolve();
		await finished.promise;
		expect(seen).toEqual(['http://first/v1', 'http://first/v1']);
	} finally {
		resume.resolve();
		probeEngine = undefined;
		fake.chat[Symbol.dispose]();
	}
});

test('a saved destination for a different synced model cannot send or carry forward', () => {
	const { chat, targets, document } = createFakeChat();
	const active = chat.active!;
	targets.set(active.id, { connectionId: 'first-id', model: 'other-model' });
	expect(active.target).toBeNull();
	expect(active.canServe).toBe(false);
	active.sendMessage('must stay a draft');
	expect(document(active.id).texts()).toEqual([]);
	const created = chat.createConversation();
	expect(targets.has(created)).toBe(false);
	chat[Symbol.dispose]();
});

test('choosing a destination writes its local identity and synced model', () => {
	const { chat, targets, updates } = createFakeChat();
	const active = chat.active!;
	active.selectTarget({ connectionId: 'second-id', model: 'chosen-model' });
	expect(targets.get(active.id)).toEqual({
		connectionId: 'second-id',
		model: 'chosen-model',
	});
	expect(updates.at(-1)).toEqual({
		id: active.id,
		patch: { model: 'chosen-model', updatedAt: expect.any(String) },
	});
	chat[Symbol.dispose]();
});

test('using the default explicitly replaces an unavailable destination', () => {
	const { chat, targets, updates } = createFakeChat();
	const active = chat.active!;
	targets.set(active.id, { connectionId: 'removed-id', model: DEFAULT_MODEL });
	expect(active.canServe).toBe(false);
	active.useDefaultModel();
	expect(targets.get(active.id)).toEqual({
		connectionId: 'first-id',
		model: DEFAULT_MODEL,
	});
	expect(updates.at(-1)).toEqual({
		id: active.id,
		patch: { model: DEFAULT_MODEL, updatedAt: expect.any(String) },
	});
	expect(active.canServe).toBe(true);
	chat[Symbol.dispose]();
});
