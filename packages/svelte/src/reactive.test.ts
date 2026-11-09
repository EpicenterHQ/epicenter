/**
 * `reactive(capability)`, the one Svelte adapter: the capability under its
 * own names and type, its synchronous reads tracking its `subscribe`. Tested
 * over the folder in memory and over stubs shaped like `openAi`, an auth
 * client and a conversation, which would otherwise each need an adapter.
 *
 * Key behaviors:
 * - A synchronous method read tracks while an effect reads it, and lets go
 *   when the last reader stops; outside an effect it is a snapshot
 * - An action answers a promise or an async iterable, so it passes through
 *   untracked, even when an effect calls it
 * - `get(args)` answering `undefined` still tracks
 * - Held capabilities, methods and returned data keep their identity
 * - A symbol-keyed member passes through as it is, whatever it holds
 * - A returned capability is adapted with its own `subscribe`, and making
 *   it tracks nothing
 * - A plain object held without a `subscribe` inherits its holder's, and its
 *   accessors set the capability's
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { flushSync } from 'svelte';
import { reactive } from './reactive.js';

const { follow } = await import('./reactive.test-support.svelte.js');

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
	},
});

/** A source whose one value a test changes, with its listeners counted. */
function source() {
	let value = 0;
	const listeners = new Set<() => void>();
	return {
		listeners,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		value: () => value,
		bump() {
			value++;
			for (const listener of [...listeners]) listener();
		},
	};
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) {
		await Bun.sleep(1);
		flushSync();
	}
	expect(check()).toBe(true);
}

test('a synchronous method read tracks while an effect reads it, and lets go when the last reader stops', async () => {
	const raw = source();
	const adapted = reactive(raw);
	expect(adapted.value()).toBe(0);
	expect(raw.listeners.size).toBe(0);

	const read = follow(() => adapted.value());
	flushSync();
	expect(raw.listeners.size).toBe(1);
	raw.bump();
	flushSync();
	expect(read.values).toEqual([0, 1]);

	read.stop();
	await Bun.sleep(0);
	expect(raw.listeners.size).toBe(0);
});

test('an action passes through untracked: called in an effect, it subscribes nothing', async () => {
	const raw = {
		...source(),
		save: async () => 'saved',
		async *stream() {
			yield 'chunk';
		},
	};
	const adapted = reactive(raw);
	const saved: Promise<string>[] = [];
	const run = follow(() => {
		saved.push(adapted.save());
		return adapted.stream();
	});
	flushSync();
	expect(raw.listeners.size).toBe(0);
	expect(await saved[0]).toBe('saved');
	const chunks: string[] = [];
	for await (const chunk of run.values[0] ?? []) chunks.push(chunk);
	expect(chunks).toEqual(['chunk']);
	run.stop();
});

test('get(args) that answers undefined still tracks, so its reader sees the note once it lands', async () => {
	const raw = openFolder(todos, memory());
	await raw.todos.list();
	const folder = reactive(raw);
	const shown = follow(() => folder.todos.get({ id: 'a' })?.title);
	flushSync();
	expect(shown.values).toEqual([undefined]);
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	await until(() => shown.values.at(-1) === 'Milk');
	shown.stop();
});

test('a symbol-keyed member passes through as it is, whatever it holds', () => {
	const raw = openFolder(todos, memory());
	expect(memoryFiles(reactive(raw))).toBe(memoryFiles(raw));
});

test('held capabilities, methods and returned data keep their identity', async () => {
	const raw = openFolder(todos, memory());
	const folder = reactive(raw);
	expect(reactive(raw)).toBe(folder);
	expect(reactive(folder)).toBe(folder);
	expect(folder.todos).toBe(folder.todos);
	expect(folder.todos.items).toBe(folder.todos.items);
	const { todos: collection } = folder;
	expect(collection).toBe(folder.todos);
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	expect(folder.todos.items()).toBe(raw.todos.items());
	expect(folder.todos.get({ id: 'a' })).toBe(raw.todos.get({ id: 'a' }));
	expect(folder.state()).toBe(raw.state());
	expect(folder.todos.fieldNames).toBe(raw.todos.fieldNames);
});

test('a returned capability is adapted with its own subscribe, and making it tracks nothing', async () => {
	const folder = reactive(openFolder(todos, memory()));
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	const made = follow(() => folder.todos.edit({ id: 'a' }));
	flushSync();
	const todo = made.values[0];
	if (todo === undefined) throw new Error('expected an editor');
	expect(made.values).toHaveLength(1);

	const exists = follow(() => todo.exists());
	await folder.todos.set({ id: 'b' }, { title: 'Eggs', done: false });
	await until(() => exists.values.at(-1) === true);
	// The collection changed and the editor was heard; the effect that made it never reran.
	expect(made.values).toHaveLength(1);
	exists.stop();
	made.stop();
});

test('a plain object held without a subscribe inherits its holder’s, and its accessors set the capability’s', async () => {
	const folder = reactive(openFolder(todos, memory()));
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	const todo = folder.todos.edit({ id: 'a' });
	expect(todo.fields).toBe(todo.fields);
	const title = follow(() => todo.fields.title);
	await until(() => title.values.at(-1) === 'Milk');

	todo.fields.title = 'Oat milk';
	flushSync();
	expect(title.values.at(-1)).toBe('Oat milk');
	expect(todo.typed()).toEqual({ title: 'Oat milk' });
	await todo.landed();
	expect(folder.todos.get({ id: 'a' })?.title).toBe('Oat milk');
	title.stop();
});

// ============================================================================
// The capabilities with hand-written adapters today, as stubs of their shapes
// ============================================================================

test('an openAi-shaped capability: models() tracks, refresh, chat and transcribe are actions an effect calls untracked', async () => {
	const changes = source();
	let models = [{ id: 'small' }];
	const raw = {
		subscribe: changes.subscribe,
		models: () => models,
		endpoints: () => [{ id: 'hosted' }],
		custom: () => null,
		refresh: async () => {},
		async *chat() {
			yield { data: 'Hi', error: null };
		},
		transcribe: async () => ({ data: 'words', error: null }),
	};
	const ai = reactive(raw);
	const shown = follow(() => ai.models().map(({ id }) => id));
	flushSync();
	models = [...models, { id: 'large' }];
	changes.bump();
	flushSync();
	expect(shown.values).toEqual([['small'], ['small', 'large']]);
	expect(ai.models()).toBe(models);
	shown.stop();
	await Bun.sleep(0);

	const acting = follow(() => {
		void ai.refresh();
		void ai.transcribe();
		return ai.chat();
	});
	flushSync();
	expect(changes.listeners.size).toBe(0);
	for await (const chunk of acting.values[0] ?? [])
		expect(chunk.data).toBe('Hi');
	acting.stop();
});

test('an auth-shaped capability: state() tracks, its account passes through untouched, actions and dispose carry through', async () => {
	const changes = source();
	const account = {
		baseURL: 'https://api.epicenter.so',
		fetch: async () => new Response(),
	};
	let state:
		| { status: 'signed-out'; account?: undefined }
		| { status: 'signed-in'; account: typeof account } = {
		status: 'signed-out',
	};
	let disposed = false;
	const raw = {
		subscribe: changes.subscribe,
		state: () => state,
		baseURL: 'https://api.epicenter.so',
		startSignIn: async () => ({ data: undefined, error: null }),
		[Symbol.dispose]: () => {
			disposed = true;
		},
	};
	const auth = reactive(raw);
	const status = follow(() => auth.state().status);
	flushSync();
	state = { status: 'signed-in', account };
	changes.bump();
	flushSync();
	expect(status.values).toEqual(['signed-out', 'signed-in']);
	expect(auth.state().account).toBe(account);
	expect(auth.baseURL).toBe(raw.baseURL);
	expect((await auth.startSignIn()).error).toBeNull();
	auth[Symbol.dispose]();
	expect(disposed).toBe(true);
	status.stop();
});

test('a conversation-shaped capability: snapshot() tracks, and ready passes through as the same promise', () => {
	const changes = source();
	let snapshot = { messages: [] as string[], streaming: false };
	const landed = Promise.resolve();
	const raw = {
		subscribe: changes.subscribe,
		snapshot: () => snapshot,
		landed,
		send: async (text: string) => {
			snapshot = { ...snapshot, messages: [...snapshot.messages, text] };
			changes.bump();
		},
	};
	const conversation = reactive(raw);
	expect(conversation.landed).toBe(landed);
	const messages = follow(() => conversation.snapshot().messages.length);
	flushSync();
	void conversation.send('Hola');
	flushSync();
	expect(messages.values).toEqual([0, 1]);
	messages.stop();
});
