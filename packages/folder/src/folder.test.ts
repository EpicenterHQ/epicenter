/**
 * Folder Tests
 *
 * The folder every build's `openFolder` returns (`createFolder`), over a
 * memory store whose open each test settles by hand.
 *
 * Key behaviors:
 * - It is handed over opening; a read of a collection before it connected
 *   throws `FolderNotOpen`
 * - A write made while opening waits for the open, then lands
 * - A temporary failure to open (`Unavailable`) is tried again on its own,
 *   and says why in `unavailable()`; any other failure is `failed`
 * - `retry()` opens again; a failure rejects the writes waiting then with
 *   `FolderClosed`, and so does disposing
 * - A collection shows what the connection read, and its own writes
 * - Disposing closes the store, even one that opens after; a later write
 *   throws, and a later read answers `Unavailable`
 */
import { describe, expect, test } from 'bun:test';
import { ClientError, defineContract } from '@epicenter/definition/contract';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import { memoryStore } from './device/memory-store.js';
import type { Store, Unavailable } from './device/store.js';
import { FolderClosed, FolderNotOpen, OpenFolderError } from './errors.js';
import { createFolder, type FolderState } from './folder.js';
import { memory, memoryFiles } from './memory.js';
import { openFolder } from './open-folder.js';

const todos = defineContract({
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: { title: { type: 'string' }, done: { type: 'boolean' } },
			required: ['title', 'done'],
		},
		attachments: { path: 'attachments/{id}.{ext}' },
	},
});
type Opened = Result<Store, OpenFolderError | Unavailable>;

/** A folder whose opens the test settles: each `open()` call waits on the next deferred answer. */
function controlled() {
	const answers: ((opened: Opened) => void)[] = [];
	const closed: Store[] = [];
	const folder = createFolder(
		todos,
		() => new Promise<Opened>((resolve) => answers.push(resolve)),
	);
	const store = () => {
		const made: Store = {
			...memoryStore(),
			close: () => {
				closed.push(made);
			},
		};
		return made;
	};
	return {
		folder,
		closed,
		/** Settle the latest open attempt with a new memory store, answered. */
		open(opened: Store = store()) {
			answers.at(-1)?.(Ok(opened));
			return opened;
		},
		/** Settle the latest open attempt with `error`. */
		fail(
			error: Err<
				OpenFolderError | Unavailable
			> = OpenFolderError.StorageUnavailable({ cause: 'no disk' }),
		) {
			answers.at(-1)?.(error);
		},
		attempts: () => answers.length,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const after = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry the folder's failed open, as Recovery's Retry does. */
function retry(folder: { state(): FolderState }) {
	const state = folder.state();
	if (state.status !== 'failed') throw new Error('expected a failed open');
	return state.retry();
}

describe('opening', () => {
	test('is handed over opening, and a read of its collections before it connected throws', () => {
		const { folder } = controlled();
		expect(folder.state()).toEqual({ status: 'opening' });
		expect(folder.unavailable()).toBeNull();
		expect(folder.saving()).toBe(false);
		expect(() => folder.todos.items()).toThrow(FolderNotOpen);
		expect(() => folder.todos.invalid()).toThrow(FolderNotOpen);
		expect(() => folder.todos.get({ id: 'a' })).toThrow(FolderNotOpen);
		expect(folder.todos.fieldNames).toEqual(['title', 'done']);
	});

	test('a write made while opening waits for the open, then lands', async () => {
		const { folder, open } = controlled();
		let answered = false;
		const set = folder.todos
			.set({ id: 'a' }, { title: 'Milk', done: false })
			.then(() => {
				answered = true;
			});
		await tick();
		expect(answered).toBe(false);
		expect(folder.saving()).toBe(true);
		open();
		await set;
		expect(folder.todos.get({ id: 'a' })).toEqual({
			id: 'a',
			title: 'Milk',
			done: false,
			body: '',
		});
		expect(folder.saving()).toBe(false);
		expect(folder.state()).toEqual({ status: 'open' });
	});

	test('state() keeps its identity until it changes, and subscribe hears each change', async () => {
		const { folder, open } = controlled();
		const seen: string[] = [];
		folder.subscribe(() => seen.push(folder.state().status));
		expect(folder.state()).toBe(folder.state());
		open();
		await tick();
		expect(seen).toEqual(['open']);
		expect(folder.state()).toBe(folder.state());
	});

	test('a temporary failure to open is tried again on its own, saying why meanwhile', async () => {
		const { folder, fail, open, attempts } = controlled();
		const set = folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
		fail(ClientError.Unavailable({ cause: 'offline' }));
		await tick();
		expect(folder.state()).toEqual({ status: 'opening' });
		expect(folder.unavailable()).toMatchObject({
			name: 'Unavailable',
			cause: 'offline',
		});
		await after(600);
		expect(attempts()).toBe(2);
		open();
		await set;
		expect(folder.state()).toEqual({ status: 'open' });
		expect(folder.unavailable()).toBeNull();
		expect(folder.todos.get({ id: 'a' })?.title).toBe('Milk');
	});
});

describe('a failed open', () => {
	test('answers a waiting read and a later one with the typed open error', async () => {
		const { folder, fail } = controlled();
		const waiting = folder.todos.list();
		fail(
			OpenFolderError.Disconnected({
				folder: '/Users/me/Epicenter/todos',
				target: '/Volumes/gone',
			}),
		);
		const { error } = await waiting;
		expect(error?.name).toBe('Disconnected');
		expect(folder.state()).toMatchObject({
			status: 'failed',
			error: { name: 'Disconnected' },
		});
		expect(folder.unavailable()).toBeNull();
		expect((await folder.todos.list()).error?.name).toBe('Disconnected');
	});

	test('rejects the writes waiting with FolderClosed, which are not made after a retry opens', async () => {
		const { folder, fail, open } = controlled();
		const waiting = folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
		expect(folder.saving()).toBe(true);
		fail();
		expect(await waiting.catch((error: unknown) => error)).toBeInstanceOf(
			FolderClosed,
		);
		expect(folder.saving()).toBe(false);
		// A write made while it is failed is not kept either.
		expect(
			await folder.todos
				.set({ id: 'b' }, { title: 'Bread', done: false })
				.catch((error: unknown) => error),
		).toMatchObject({ name: 'FolderClosed', status: 'failed' });
		const opening = retry(folder);
		const store = open();
		await opening;
		await tick();
		expect((await store.read(['todos/a.md'])).data).toEqual([
			{ path: 'todos/a.md', gone: true },
		]);
	});

	test('disposing rejects the writes waiting with FolderClosed', async () => {
		const { folder } = controlled();
		const waiting = folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
		folder[Symbol.dispose]();
		expect(await waiting.catch((error: unknown) => error)).toMatchObject({
			name: 'FolderClosed',
			status: 'closed',
		});
	});

	test('an open that throws fails as StorageUnavailable', async () => {
		const folder = createFolder(todos, async () => {
			throw new Error('the shell did not answer');
		});
		const { error } = await folder.todos.list();
		expect(error?.name).toBe('StorageUnavailable');
		expect(folder.state().status).toBe('failed');
	});

	test("the failed state's retry() opens again, and a read made after it waits for the new attempt", async () => {
		const { folder, fail, open, attempts } = controlled();
		fail();
		await tick();
		expect(folder.state().status).toBe('failed');
		void retry(folder);
		expect(attempts()).toBe(2);
		expect(folder.state()).toEqual({ status: 'opening' });
		const listed = folder.todos.list();
		open();
		const { data, error } = await listed;
		expect(error).toBeNull();
		expect(data?.items).toEqual([]);
		expect(folder.state()).toEqual({ status: 'open' });
	});

	test("a failure's retry() does nothing once the folder moved on", async () => {
		const { folder, fail, open, attempts } = controlled();
		fail();
		await tick();
		const failed = folder.state();
		if (failed.status !== 'failed') throw new Error('expected a failure');
		void failed.retry();
		open();
		await tick();
		await failed.retry();
		expect(attempts()).toBe(2);
		expect(folder.state()).toEqual({ status: 'open' });
	});
});

describe('a startup job made beside the folder', () => {
	/**
	 * A recovery-style job, as Whispering finishes cut-off recordings: it
	 * runs at once in app.ts, beside the folder, lists a collection, and
	 * repairs what it finds. It never reads `state()`.
	 */
	async function finishUntitled(
		folder: ReturnType<typeof controlled>['folder'],
	) {
		const listed = await folder.todos.list();
		if (listed.error !== null) return listed;
		let finished = 0;
		for (const todo of listed.data.items)
			if (todo.title === '') {
				await folder.todos.set({ id: todo.id }, { title: 'Untitled' });
				finished++;
			}
		return Ok(finished);
	}

	test('started while the folder opens, it waits for the open and then succeeds', async () => {
		const { folder, open } = controlled();
		const job = finishUntitled(folder);
		await tick();
		expect(folder.state()).toEqual({ status: 'opening' });
		const store = memoryStore();
		await store.outside.write(
			'todos/a.md',
			'---\ntitle: ""\ndone: false\n---\n',
		);
		await store.outside.write(
			'todos/b.md',
			'---\ntitle: Milk\ndone: false\n---\n',
		);
		open(store);
		expect(await job).toEqual(Ok(1));
		expect(store.outside.read('todos/a.md')).toBe(
			'---\ntitle: Untitled\ndone: false\n---\n',
		);
	});

	test('started while the folder opens, it answers the open’s typed error when the open fails', async () => {
		const { folder, fail } = controlled();
		const job = finishUntitled(folder);
		fail(
			OpenFolderError.Refused({
				folder: '/Users/me',
				reason: 'This is your home folder.',
			}),
		);
		const { error } = await job;
		expect(error).toMatchObject({
			name: 'Refused',
			message: 'This is your home folder.',
		});
	});
});

describe('reads', () => {
	test('a collection shows what the connection read, and its own writes', async () => {
		const { folder, open } = controlled();
		const store = memoryStore();
		await store.outside.write(
			'todos/a.md',
			'---\ntitle: Milk\ndone: false\n---\n',
		);
		open(store);
		let heard = 0;
		const stop = folder.todos.subscribe(() => heard++);
		await tick();
		expect(folder.state().status).toBe('open');
		expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
		const before = folder.todos.items();
		expect(folder.todos.items()).toBe(before);

		await folder.todos.set({ id: 'b' }, { title: 'Eggs', done: false });
		expect(folder.todos.items().map((todo) => todo.title)).toContain('Eggs');
		await folder.todos.delete({ id: 'b' });
		expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
		expect(heard).toBeGreaterThan(0);
		stop();
	});

	test('a connection that cannot list the store stays opening and says why, until one can', async () => {
		const place = memory();
		const undo = memoryFiles(place).refuseReads('offline');
		const folder = openFolder(todos, place);
		await tick();
		await tick();
		expect(folder.state()).toEqual({ status: 'opening' });
		expect(folder.unavailable()).toMatchObject({ cause: 'offline' });
		undo();
		await after(600);
		expect(folder.state()).toEqual({ status: 'open' });
		expect(folder.unavailable()).toBeNull();
		expect(folder.todos.items()).toEqual([]);
	});

	test('a file collection lists its entries without bytes', async () => {
		const { folder, open } = controlled();
		open();
		folder.attachments.subscribe(() => {});
		await folder.attachments.set(
			{ id: 'a', ext: 'png' },
			new Uint8Array([1, 2, 3]),
		);
		await tick();
		expect(folder.attachments.items()).toEqual([{ id: 'a', ext: 'png' }]);
		expect(
			(await folder.attachments.read({ id: 'a', ext: 'png' })).data,
		).toEqual({ id: 'a', ext: 'png', bytes: new Uint8Array([1, 2, 3]) });
		expect(
			(await folder.attachments.read({ id: 'b', ext: 'png' })).data,
		).toBeNull();
	});
});

describe('dispose', () => {
	test('closes the store that opened, and the state is closed', async () => {
		const { folder, open, closed } = controlled();
		const store = open();
		await tick();
		const seen: string[] = [];
		folder.subscribe(() => seen.push(folder.state().status));
		folder[Symbol.dispose]();
		await tick();
		expect(closed).toHaveLength(1);
		expect(store).toBeDefined();
		expect(seen).toEqual(['closed']);
	});

	test('a write after it throws, and a read answers Unavailable', async () => {
		const folder = openFolder(todos, memory());
		await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
		folder[Symbol.dispose]();
		expect(() =>
			folder.todos.set({ id: 'b' }, { title: 'Bread', done: false }),
		).toThrow('disposed');
		expect((await folder.todos.list()).error).toMatchObject({
			name: 'Unavailable',
			cause: 'The folder was closed.',
		});
	});

	test('a read waiting for the open when it is disposed answers Unavailable', async () => {
		const { folder, open } = controlled();
		const waiting = folder.todos.list();
		folder[Symbol.dispose]();
		open();
		expect((await waiting).error?.name).toBe('Unavailable');
	});

	test('closes a store that opens after it, and the state stays closed', async () => {
		const { folder, open, closed } = controlled();
		folder[Symbol.dispose]();
		open();
		await tick();
		expect(closed).toHaveLength(1);
		expect(folder.state()).toEqual({ status: 'closed' });
	});
});

test('a collection named like a lifecycle member throws', () => {
	for (const name of ['state', 'unavailable', 'saving']) {
		const contract = defineContract({
			collections: { [name]: { path: `${name}/{id}.md` } },
		});
		expect(() => createFolder(contract, async () => Ok(memoryStore()))).toThrow(
			`collection named ${name}`,
		);
	}
});

test('a folder in memory is seeded through its ordinary methods, and each place is a new one', async () => {
	const folder = openFolder(todos, memory());
	await folder.todos.set({ id: 'a' }, { title: 'Milk', done: false });
	const { data } = await folder.todos.list();
	expect(data?.items.map((todo) => todo.title)).toEqual(['Milk']);
	expect(openFolder(todos, memory())).not.toBe(folder);
	expect((await openFolder(todos, memory()).todos.list()).data?.items).toEqual(
		[],
	);
});

test('on the web, a folder over an account opens once the account is signed in', async () => {
	const { home } = await import('./home.js');
	let signedIn:
		| { baseURL: string; signal: AbortSignal; fetch: typeof fetch }
		| undefined;
	const listeners = new Set<() => void>();
	const account = {
		state: () => ({ account: signedIn }),
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const folder = openFolder(
		todos,
		home({ site: 'https://todos.epicenter.so', account }),
	);
	await tick();
	expect(folder.state()).toEqual({ status: 'opening' });
	signedIn = {
		baseURL: 'https://api.epicenter.so',
		signal: new AbortController().signal,
		// An empty repository: main is nowhere, and nothing is listed.
		fetch: (async (url: string) =>
			Response.json(
				String(url).includes('/epicenter/changes')
					? { commit: null, paths: null }
					: { commit: null, files: [] },
			)) as never,
	};
	for (const listener of [...listeners]) listener();
	await tick();
	expect(folder.state()).toEqual({ status: 'open' });
	expect(listeners.size).toBe(0);
});

test('reveal is the opener’s, and answers even when the open failed', async () => {
	const revealed: string[] = [];
	const folder = createFolder(
		todos,
		async () => OpenFolderError.StorageUnavailable({ cause: 'no disk' }),
		{
			reveal: async () => {
				revealed.push('Data');
				return Ok(null);
			},
		},
	);
	await tick();
	expect(folder.state().status).toBe('failed');
	expect((await folder.reveal?.())?.error).toBeNull();
	expect(revealed).toEqual(['Data']);
});
