/**
 * Folder Query Option Tests
 *
 * `folderOptions(folder)` gives TanStack options for every read and write of
 * a folder, and `pathFilter` names the queries a change can have made stale.
 * These run the options through a real `QueryClient` over a browser folder
 * in the in-memory stand-in.
 *
 * Key behaviors:
 * - Keys are stable for one folder and differ between folders
 * - `pathFilter` covers a changed row, its table's listing, `kv.json`, a
 *   changed file and the file listing, and the history's status; a change
 *   inside `.git` also covers the log; `'everything'` covers every query of
 *   the folder and none of another's
 * - A row write updates its row and the listing from its own result, even
 *   with the caller's own `onSuccess`, and marks stale the rest a change to
 *   its path would: the history's status, the file's read and listing
 * - A delete drops the row and its listing entry
 * - A read running when a write lands is done again rather than landing
 *   over the write
 * - A file write puts what it wrote in the file's read and text queries
 * - The folder write (`folder$.write`) does too, and marks a row and its
 *   listing stale when its path is a row; a move (`folder$.move`) marks
 *   both paths stale
 * - A failed write reads its path again
 * - Two controls' sets of one row run one at a time, in the order made,
 *   each over the row the one before wrote, and keep the cache
 * - `runMutation` runs a write through the cache; `whenIdle` waits for it
 * - A change another page made, wired from `onFilesChanged` to
 *   `invalidateQueries`, marks exactly the affected queries stale
 */
import { afterEach, expect, test } from 'bun:test';
import { MutationObserver, QueryClient } from '@tanstack/query-core';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	type TestStorage,
} from './browser-storage.test-support.js';
import { defineFolder, defineTable, type Folder, field } from './contract.js';
import { folderOptions, runMutation, whenIdle } from './query.js';
import { mustRow } from './row-write.test-support.js';
import { isStoredRow } from './table.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Todos = Folder<typeof definition>;
const author = { name: 'Query', email: 'query@example.test' };

const opened: Todos[] = [];
const clients: QueryClient[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) client.clear();
	for (const folder of opened.splice(0)) await folder.close();
});

async function open(id = 'so.epicenter.querytest', storage?: TestStorage) {
	const folder = expectOk(
		await openFolder({
			id,
			definition,
			browser: {
				author,
				...browserStorage(storage ?? createTestStorage()),
			},
		}),
	);
	opened.push(folder);
	return folder;
}

function client() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	});
	clients.push(queryClient);
	return queryClient;
}

/** The keys of the cached queries `filters` matches. */
function matched(
	queryClient: QueryClient,
	filters: Parameters<QueryClient['invalidateQueries']>[0],
) {
	return queryClient
		.getQueryCache()
		.findAll(filters)
		.map((query) => query.queryKey);
}

test('keys are stable for one folder and differ between folders', async () => {
	const folder = await open();
	const other = await open('so.epicenter.querytest.other');
	expect(folderOptions(folder).todos.get.queryKey('a')).toEqual(
		folderOptions(folder).todos.get.queryKey('a'),
	);
	expect(folderOptions(folder).todos.list.queryOptions().queryKey).toEqual(
		folderOptions(folder).todos.list.queryKey(),
	);
	expect(folderOptions(folder).todos.get.queryKey('a')).not.toEqual(
		folderOptions(other).todos.get.queryKey('a'),
	);
	// Every table is also under `tables`.
	expect(folderOptions(folder).tables.todos.list.queryKey()).toEqual(
		folderOptions(folder).todos.list.queryKey(),
	);
});

test('pathFilter covers the row, its listing, kv.json, the files, and history', async () => {
	const folder = await open();
	const other = await open('so.epicenter.querytest.other');
	const folder$ = folderOptions(folder);
	const other$ = folderOptions(other);
	const queryClient = client();
	const keys = {
		a: folder$.todos.get.queryKey('a'),
		b: folder$.todos.get.queryKey('b'),
		list: folder$.todos.list.queryKey(),
		kv: folder$.kv.get.queryKey(),
		files: folder$.files.list.queryKey(),
		note: folder$.files.read.queryKey('note.txt'),
		noteText: folder$.files.text.queryKey('note.txt'),
		chats: folder$.query({
			paths: ['chats', 'messages'],
			key: ['summaries'],
			queryFn: async () => Ok(1),
		}).queryKey,
		status: folder$.history.status.queryKey(),
		log: folder$.history.log.queryKey(),
		elsewhere: other$.todos.get.queryKey('a'),
	};
	for (const key of Object.values(keys)) queryClient.setQueryData(key, 1);

	expect(matched(queryClient, folder$.pathFilter(['todos/a.md']))).toEqual([
		keys.a,
		keys.list,
		keys.files,
		keys.status,
	]);
	expect(matched(queryClient, folder$.pathFilter(['kv.json']))).toEqual([
		keys.kv,
		keys.files,
		keys.status,
	]);
	expect(matched(queryClient, folder$.pathFilter(['note.txt']))).toEqual([
		keys.files,
		keys.note,
		keys.noteText,
		keys.status,
	]);
	// A query of the page's own follows every path it names.
	expect(
		matched(queryClient, folder$.pathFilter(['messages/c1-m1.md'])),
	).toEqual([keys.files, keys.chats, keys.status]);
	// History moved: status and log, and no file.
	expect(
		matched(queryClient, folder$.pathFilter(['.git/refs/heads/main'])),
	).toEqual([keys.status, keys.log]);
	expect(
		new Set(matched(queryClient, folder$.pathFilter('everything'))),
	).toEqual(
		new Set(
			Object.entries(keys)
				.filter(([name]) => name !== 'elsewhere')
				.map(([, key]) => key),
		),
	);
});

/** The keys of the queries `queryClient` holds as invalidated. */
const invalidatedIn = (queryClient: QueryClient) =>
	queryClient
		.getQueryCache()
		.findAll()
		.filter((query) => query.state.isInvalidated)
		.map((query) => query.queryKey);

test('a set puts its row in the row and the listing, and marks the rest of its path stale', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	await queryClient.fetchQuery(folder$.todos.get.queryOptions('milk'));
	queryClient.setQueryData(folder$.history.status.queryKey(), 'before');
	queryClient.setQueryData(folder$.files.text.queryKey('todos/milk.md'), 1);
	let told = 0;

	// The caller's own `onSuccess` adds to the set; the cache is still kept.
	const setTodo = new MutationObserver(queryClient, {
		...folder$.todos.set.mutationOptions(),
		onSuccess: () => {
			told++;
		},
	});
	const written = await setTodo.mutate({
		stem: 'milk',
		fields: { done: true },
	});

	expect(told).toBe(1);
	if (!isStoredRow(written)) throw new Error('the set left no row');
	expect(written.row.fields.done).toBe(true);
	expect<unknown>(
		queryClient.getQueryData(folder$.todos.get.queryKey('milk')),
	).toEqual(written);
	const listing = queryClient.getQueryData<
		Awaited<ReturnType<typeof folder.tables.todos.list>>['data']
	>(folder$.todos.list.queryKey());
	expect(listing?.map((item) => item.result.data)).toEqual([written]);
	// The folder does not report the page's own write to it: the write marks
	// what else a change to its file makes stale.
	expect(invalidatedIn(queryClient)).toEqual([
		folder$.history.status.queryKey(),
		folder$.files.text.queryKey('todos/milk.md'),
	]);
});

test('a delete drops the row and its listing entry', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	for (const stem of ['a', 'b'])
		expectOk(
			await folder.tables.todos.create(
				{ fields: { title: stem, done: false }, body: '' },
				{ stem },
			),
		);
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	await queryClient.fetchQuery(folder$.todos.get.queryOptions('a'));
	const stems = () =>
		queryClient
			.getQueryData<{ stem: string }[]>(folder$.todos.list.queryKey())
			?.map((item) => item.stem)
			.sort();

	await new MutationObserver(
		queryClient,
		folder$.todos.delete.mutationOptions(),
	).mutate('a');
	expect(queryClient.getQueryData(folder$.todos.get.queryKey('a'))).toBeNull();
	expect(stems()).toEqual(['b']);
});

test('a read running when a write lands is read again, not kept over the write', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const created = mustRow(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	// A read that answers the version from before the save, after it lands.
	let answer = () => {};
	const late = queryClient.fetchQuery({
		...folder$.todos.get.queryOptions('milk'),
		queryFn: (): Promise<typeof created> =>
			new Promise((resolve) => {
				answer = () => resolve(created);
			}),
	});
	await new MutationObserver(
		queryClient,
		folder$.todos.set.mutationOptions(),
	).mutate({ stem: 'milk', fields: { done: true } });
	answer();
	await late.catch(() => undefined);

	expect(
		queryClient.getQueryData(folder$.todos.get.queryKey('milk')),
	).not.toEqual(created);
	const row = await queryClient.fetchQuery(
		folder$.todos.get.queryOptions('milk'),
	);
	expect(row?.row.fields.done).toBe(true);
});

test('a file write puts what it wrote in the file read and text, reading nothing back', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(await folder.write('note.txt', null, 'one\n'));
	const first = expectOk(await folder.files.read('note.txt'));
	await queryClient.fetchQuery(folder$.files.read.queryOptions('note.txt'));
	await queryClient.fetchQuery(folder$.files.text.queryOptions('note.txt'));

	const write = new MutationObserver(
		queryClient,
		folder$.files.write.mutationOptions(),
	);
	const saved = await write.mutate({
		path: 'note.txt',
		content: 'two\n',
		base: first,
	});

	expect<unknown>(
		queryClient.getQueryData(folder$.files.read.queryKey('note.txt')),
	).toEqual(saved.stored);
	expect<unknown>(
		queryClient.getQueryData(folder$.files.text.queryKey('note.txt')),
	).toEqual({
		kind: 'text',
		file: { path: 'note.txt', text: 'two\n', sha256: saved.stored.sha256 },
	});
	expect(invalidatedIn(queryClient)).toEqual([]);
});

test('the folder write puts what it wrote in the file read and text, reading nothing back', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(await folder.write('note.txt', null, 'one\n'));
	await queryClient.fetchQuery(folder$.files.read.queryOptions('note.txt'));
	await queryClient.fetchQuery(folder$.files.text.queryOptions('note.txt'));

	const writeFile = new MutationObserver(
		queryClient,
		folder$.write.mutationOptions(),
	);
	const written = await writeFile.mutate({
		path: 'note.txt',
		from: 'one\n',
		to: 'two\n',
	});

	expect(written.file).not.toBeNull();
	expect<unknown>(
		queryClient.getQueryData(folder$.files.read.queryKey('note.txt')),
	).toEqual({ path: 'note.txt', ...written.file });
	expect<unknown>(
		queryClient.getQueryData(folder$.files.text.queryKey('note.txt')),
	).toEqual({
		kind: 'text',
		file: { path: 'note.txt', text: 'two\n', sha256: written.file?.sha256 },
	});
	expect(invalidatedIn(queryClient)).toEqual([]);
});

test("the folder write to a row's path marks the row and its listing stale", async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const created = mustRow(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	await queryClient.fetchQuery(folder$.todos.get.queryOptions('milk'));

	await new MutationObserver(
		queryClient,
		folder$.write.mutationOptions(),
	).mutate({ path: created.path, from: created.text, to: null });

	expect(invalidatedIn(queryClient)).toEqual([
		folder$.todos.list.queryKey(),
		folder$.todos.get.queryKey('milk'),
	]);
	await queryClient.refetchQueries();
	expect(
		queryClient.getQueryData(folder$.todos.get.queryKey('milk')),
	).toBeNull();
});

test('a move reads both paths again', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(await folder.write('a.txt', null, 'one\n'));
	await queryClient.fetchQuery(folder$.files.list.queryOptions());
	await queryClient.fetchQuery(folder$.files.read.queryOptions('a.txt'));

	const moved = await new MutationObserver(
		queryClient,
		folder$.move.mutationOptions(),
	).mutate({ path: 'a.txt', next: 'b.txt' });

	expect(moved.path).toBe('b.txt');
	expect(invalidatedIn(queryClient)).toEqual([
		folder$.files.list.queryKey(),
		folder$.files.read.queryKey('a.txt'),
	]);
});

test('a failed write reads its path again', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	await queryClient.fetchQuery(folder$.todos.get.queryOptions('milk'));

	const setTodo = new MutationObserver(
		queryClient,
		folder$.todos.set.mutationOptions(),
	);
	const failed = await setTodo
		.mutate({ stem: 'milk', fields: { done: 'maybe' as never } })
		.catch((error: { name: string }) => error);
	expect(failed).toMatchObject({ name: 'InvalidValues' });
	expect(invalidatedIn(queryClient)).toEqual([
		folder$.todos.get.queryKey('milk'),
	]);
});

test("two controls' sets of one row run in the order made, each over the last one's write", async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	// Two controls of one row, each with its own mutation.
	const title = new MutationObserver(
		queryClient,
		folder$.todos.set.mutationOptions(),
	);
	const done = new MutationObserver(
		queryClient,
		folder$.todos.set.mutationOptions(),
	);
	const read = folder.tables.todos.get;
	const titlesRead: string[] = [];
	folder.tables.todos.get = async (stem) => {
		const result = await read(stem);
		if (result.data) titlesRead.push(result.data.row.fields.title);
		return result;
	};

	const first = title.mutate({ stem: 'milk', fields: { title: 'Oat milk' } });
	const second = done.mutate({ stem: 'milk', fields: { done: true } });
	await Promise.all([first, second]);

	// The second set waited for the first: it read the title it wrote.
	expect(titlesRead).toEqual(['Milk', 'Oat milk']);
	const cached = queryClient.getQueryData<{ row: { fields: unknown } }>(
		folder$.todos.get.queryKey('milk'),
	);
	expect(cached?.row.fields).toEqual({ title: 'Oat milk', done: true });
});

test("another page's change, wired from onFilesChanged, invalidates exactly what it names", async () => {
	const storage = createTestStorage({ BroadcastChannel });
	const writer = await open('so.epicenter.querytest', storage);
	const reader = await open('so.epicenter.querytest', storage);
	const reader$ = folderOptions(reader);
	const queryClient = client();
	expectOk(
		await writer.tables.todos.create(
			{ fields: { title: 'A', done: false }, body: '' },
			{ stem: 'a' },
		),
	);
	expectOk(
		await writer.tables.todos.create(
			{ fields: { title: 'B', done: false }, body: '' },
			{ stem: 'b' },
		),
	);
	await Bun.sleep(20);
	await queryClient.fetchQuery(reader$.todos.get.queryOptions('a'));
	await queryClient.fetchQuery(reader$.todos.get.queryOptions('b'));
	await queryClient.fetchQuery(reader$.kv.get.queryOptions());

	// The app root's one line.
	reader$.invalidateOnChange(queryClient);
	expectOk(await writer.tables.todos.set('a', { title: 'A, edited' }));
	const invalidated = () =>
		queryClient
			.getQueryCache()
			.findAll({ queryKey: reader$.key })
			.filter((query) => query.state.isInvalidated)
			.map((query) => query.queryKey);
	for (let tries = 0; tries < 50 && invalidated().length === 0; tries++)
		await Bun.sleep(5);
	expect(invalidated()).toEqual([reader$.todos.get.queryKey('a')]);
	// Reading again goes through the engine and finds the other page's row.
	const row = await queryClient.fetchQuery(reader$.todos.get.queryOptions('a'));
	expect(row?.row.fields.title).toBe('A, edited');
});

test('runMutation runs a write through the cache, and whenIdle waits for it', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const running = runMutation(
		queryClient,
		folder$.todos.create.mutationOptions(),
		{
			row: { fields: { title: 'Milk', done: false }, body: '' },
			stem: 'milk',
		},
	);
	expect(queryClient.isMutating()).toBe(1);
	await whenIdle(queryClient);
	expect(queryClient.isMutating()).toBe(0);
	expect((await running)?.path).toBe('todos/milk.md');
	await expect(
		runMutation(queryClient, folder$.todos.create.mutationOptions(), {
			row: { fields: { title: 'Milk', done: 'maybe' as never }, body: '' },
			stem: 'other',
		}),
	).rejects.toMatchObject({ name: 'InvalidValues' });
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
