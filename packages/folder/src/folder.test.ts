/**
 * Folder Tests
 *
 * The folder every build's `openFolder` returns (`createFolder`), over a
 * memory client whose open each test settles by hand.
 *
 * Key behaviors:
 * - It is handed over opening; reads answer at once (empty, loading)
 * - An action called while opening waits, then runs
 * - A failed open answers each waiting and later action with its typed error
 * - `retry()` opens again, and actions called after it wait for that attempt
 * - A listened collection lists once open, and shows its own writes
 * - Disposing closes the client, even one that opens after
 */
import { describe, expect, test } from 'bun:test';
import { type Client, defineContract } from '@epicenter/definition/contract';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import { createDeviceClient } from './device/client.js';
import { memoryStore } from './device/memory-store.js';
import { OpenFolderError } from './errors.js';
import { createFolder, type FolderState, folderOf } from './folder.js';
import { openFolder } from './open-folder.memory.js';

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
type Opened = Result<Client<typeof todos>, OpenFolderError>;

/** A folder whose opens the test settles: each `open()` call waits on the next deferred answer. */
function controlled() {
	const answers: ((opened: Opened) => void)[] = [];
	const closed: Client<typeof todos>[] = [];
	const folder = createFolder(
		todos,
		() => new Promise<Opened>((resolve) => answers.push(resolve)),
		{ close: (client) => closed.push(client) },
	);
	const client = () => createDeviceClient(todos, memoryStore());
	return {
		folder,
		closed,
		/** Settle the latest open attempt with `opened`, by default a new memory client. */
		open(opened = client()) {
			answers.at(-1)?.(Ok(opened));
			return opened;
		},
		/** Settle the latest open attempt with `error`. */
		fail(
			error: Err<OpenFolderError> = OpenFolderError.StorageUnavailable({
				cause: 'no disk',
			}),
		) {
			answers.at(-1)?.(error);
		},
		attempts: () => answers.length,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Retry the folder's failed open, as Recovery's Retry does. */
function retry(folder: { state(): FolderState }) {
	const state = folder.state();
	if (state.status !== 'failed') throw new Error('expected a failed open');
	state.retry();
}

describe('opening', () => {
	test('is handed over opening, and its collections read empty and loading', () => {
		const { folder } = controlled();
		expect(folder.state()).toEqual({ status: 'opening' });
		expect(folder.todos.items()).toEqual([]);
		expect(folder.todos.invalid()).toEqual([]);
		expect(folder.todos.loading()).toBe(true);
		expect(folder.todos.error()).toBeNull();
		expect(folder.todos.fieldNames).toEqual(['title', 'done']);
	});

	test('an action called while opening waits for the open, then runs', async () => {
		const { folder, open } = controlled();
		let answered = false;
		const created = folder.todos
			.create({ id: 'a', title: 'Milk', done: false })
			.then((result) => {
				answered = true;
				return result;
			});
		await tick();
		expect(answered).toBe(false);
		open();
		const { data, error } = await created;
		expect(error).toBeNull();
		expect(data?.title).toBe('Milk');
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
});

describe('a failed open', () => {
	test('answers a waiting action and a later one with the typed open error', async () => {
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
		const later = await folder.todos.create({
			id: 'a',
			title: 'Milk',
			done: false,
		});
		expect(later.error?.name).toBe('Disconnected');
	});

	test('an open that throws fails as StorageUnavailable', async () => {
		const folder = createFolder(todos, async () => {
			throw new Error('the shell did not answer');
		});
		const { error } = await folder.todos.list();
		expect(error?.name).toBe('StorageUnavailable');
		expect(folder.state().status).toBe('failed');
	});

	test("the failed state's retry() opens again, and an action called after it waits for the new attempt", async () => {
		const { folder, fail, open, attempts } = controlled();
		fail();
		await tick();
		expect(folder.state().status).toBe('failed');
		retry(folder);
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
		failed.retry();
		open();
		await tick();
		failed.retry();
		expect(attempts()).toBe(2);
		expect(folder.state()).toEqual({ status: 'open' });
	});
});

describe('a startup job made beside the folder', () => {
	/**
	 * A recovery-style job, as Whispering finishes cut-off recordings: it
	 * runs at once in app.ts, beside the folder, lists a collection, and
	 * repairs what it finds. It never reads `state()` and never waits on
	 * anything but its own actions.
	 */
	async function finishUntitled(
		folder: ReturnType<typeof controlled>['folder'],
	) {
		const listed = await folder.todos.list();
		if (listed.error !== null) return listed;
		let finished = 0;
		for (const todo of listed.data.items)
			if (todo.title === '') {
				const updated = await folder.todos.update(
					{ id: todo.id },
					{ title: 'Untitled' },
					{ base: todo },
				);
				if (updated.error !== null) return updated;
				finished++;
			}
		return Ok(finished);
	}

	test('started while the folder opens, it waits for the open and then succeeds', async () => {
		const { folder, open } = controlled();
		const job = finishUntitled(folder);
		await tick();
		expect(folder.state()).toEqual({ status: 'opening' });
		const client = createDeviceClient(todos, memoryStore());
		await client.todos.create({ id: 'a', title: '', done: false });
		await client.todos.create({ id: 'b', title: 'Milk', done: false });
		open(client);
		expect(await job).toEqual(Ok(1));
		expect((await client.todos.get({ id: 'a' })).data?.title).toBe('Untitled');
	});

	test('started while the folder opens, it fails with the open’s typed error when the open fails', async () => {
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
	test('a listened collection lists once open, and shows its own writes', async () => {
		const { folder, open } = controlled();
		const client = open();
		await client.todos.create({ id: 'a', title: 'Milk', done: false });
		let heard = 0;
		const stop = folder.todos.subscribe(() => heard++);
		await tick();
		expect(folder.todos.loading()).toBe(false);
		expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
		const before = folder.todos.items();
		expect(folder.todos.items()).toBe(before);

		const created = await folder.todos.create({
			id: 'b',
			title: 'Eggs',
			done: false,
		});
		if (created.error !== null) throw new Error(created.error.message);
		expect(folder.todos.items().map((todo) => todo.title)).toContain('Eggs');
		await folder.todos.delete({ id: 'b' }, { over: created.data.version });
		expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
		expect(heard).toBeGreaterThan(0);
		stop();
	});

	test('a listened collection of a failed folder says why, and lists after a retry that opens', async () => {
		const { folder, fail, open } = controlled();
		folder.todos.subscribe(() => {});
		fail();
		await tick();
		expect(folder.todos.loading()).toBe(false);
		expect(folder.todos.error()?.name).toBe('StorageUnavailable');
		retry(folder);
		const client = open();
		await client.todos.create({ id: 'a', title: 'Milk', done: false });
		await tick();
		await tick();
		expect(folder.todos.error()).toBeNull();
		expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
	});

	test('a file collection lists its entries without bytes', async () => {
		const { folder, open } = controlled();
		open();
		folder.attachments.subscribe(() => {});
		await folder.attachments.create({
			id: 'a',
			ext: 'png',
			bytes: new Uint8Array([1, 2, 3]),
		});
		await tick();
		expect(folder.attachments.items()).toEqual([
			{ id: 'a', ext: 'png', version: expect.any(String) },
		]);
	});
});

describe('dispose', () => {
	test('closes the client that opened, and the state is closed', async () => {
		const { folder, open, closed } = controlled();
		const client = open();
		await tick();
		const seen: string[] = [];
		folder.subscribe(() => seen.push(folder.state().status));
		folder[Symbol.dispose]();
		await tick();
		expect(closed).toEqual([client]);
		expect(seen).toEqual(['closed']);
	});

	test('closes a client that opens after it, and the state stays closed', async () => {
		const { folder, open, closed } = controlled();
		folder[Symbol.dispose]();
		const client = open();
		await tick();
		expect(closed).toEqual([client]);
		expect(folder.state()).toEqual({ status: 'closed' });
	});
});

test('a collection named like a lifecycle member throws', () => {
	const contract = defineContract({
		collections: { state: { path: 'state/{id}.md' } },
	});
	expect(() => createFolder(contract, async () => Ok({} as never))).toThrow(
		'collection named state',
	);
});

test('the test condition’s folder is in memory, seeded through its ordinary methods', async () => {
	const folder = openFolder(todos);
	await folder.todos.create({ id: 'a', title: 'Milk', done: false });
	const { data } = await folder.todos.list();
	expect(data?.items.map((todo) => todo.title)).toEqual(['Milk']);
	expect(openFolder(todos)).not.toBe(folder);
	expect((await openFolder(todos).todos.list()).data?.items).toEqual([]);
});

test('on the web, a folder over an account opens once the account is signed in', async () => {
	const { openFolder: openWebFolder } = await import('./open-folder.js');
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
	const folder = openWebFolder(todos, {
		site: 'https://todos.epicenter.so',
		account,
	});
	await tick();
	expect(folder.state()).toEqual({ status: 'opening' });
	signedIn = {
		baseURL: 'https://api.epicenter.so',
		signal: new AbortController().signal,
		fetch: (async () => new Response(null, { status: 503 })) as never,
	};
	for (const listener of [...listeners]) listener();
	await tick();
	expect(folder.state()).toEqual({ status: 'open' });
	expect(listeners.size).toBe(0);
});

test('a folder over a client already open is open at once and closes nothing', async () => {
	const client = createDeviceClient(todos, memoryStore());
	await client.todos.create({ id: 'a', title: 'Milk', done: false });
	const folder = folderOf(client);
	expect(folder.reveal).toBeNull();
	expect(folder.displayPath()).toBeNull();
	expect(folder.todos.fieldNames).toEqual(['title', 'done']);
	folder.todos.subscribe(() => {});
	await tick();
	expect(folder.state()).toEqual({ status: 'open' });
	expect(folder.todos.items().map((todo) => todo.title)).toEqual(['Milk']);
	folder[Symbol.dispose]();
	expect((await client.todos.list()).error).toBeNull();
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
