/**
 * Folder Query Tests
 *
 * `folderOptions(folder)` gives TanStack options for every read of a folder,
 * and `pathFilter` names the queries a change can have made stale.
 * `folderWrites(folder, client)` writes the folder, one write per file at a
 * time, keeping the cache in step. These run through a real `QueryClient`
 * over a browser folder in the in-memory stand-in.
 *
 * Key behaviors:
 * - Keys are stable for one folder and differ between folders
 * - `pathFilter` covers a changed row's listing, a changed file and the file
 *   listing, and the history's status; a change inside `.git` covers status
 *   and no file; `'everything'` covers every query of the folder and none
 *   of another's
 * - A row write puts its row in the listing from its own result and marks
 *   stale the rest a change to its path would: the history's status, the
 *   file's text
 * - A delete drops the listing entry
 * - A read running when a write lands is done again rather than landing
 *   over the write
 * - The folder write puts what it wrote in the file's read and text
 *   queries, and marks a row's listing stale when its path is a row; a move
 *   marks both paths stale
 * - A failed write reads its path again and answers the engine's error
 * - Two sets of one row run one at a time, in the order made, each over the
 *   row the one before wrote; `pending` and `idle` count them, and work run
 *   in a file's turn waits for them too
 * - A change another page made, wired from `onFilesChanged` to
 *   `invalidateQueries`, marks exactly the affected queries stale
 */
import { afterEach, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/query-core';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
	type TestStorage,
} from './browser-storage.test-support.js';
import { defineFolder, defineTable, type LegacyFolder as Folder, field } from './contract.js';
import { folderOptions, folderWrites } from './query.js';
import { mustRow } from './row-write.test-support.js';
import { isStoredRow, type TableListing } from './table.js';
import { useWebLocks } from './web-locks.test-support.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
type Todos = Folder<typeof definition>;
type Todo = { title: string; done: boolean };
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
			app: id,
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

/** A folder with the row `milk`, its options, and its writes over one client. */
async function openWithMilk() {
	const folder = await open();
	const queryClient = client();
	const created = mustRow(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk', done: false }, body: '' },
			{ stem: 'milk' },
		),
	);
	return {
		folder,
		created,
		queryClient,
		folder$: folderOptions(folder),
		writes: folderWrites(folder, queryClient),
	};
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

/** The keys of the queries `queryClient` holds as invalidated. */
const invalidatedIn = (queryClient: QueryClient) =>
	queryClient
		.getQueryCache()
		.findAll()
		.filter((query) => query.state.isInvalidated)
		.map((query) => query.queryKey);

test('keys are stable for one folder and differ between folders', async () => {
	const folder = await open();
	const other = await open('so.epicenter.querytest.other');
	expect(folderOptions(folder).todos.list.queryKey()).toEqual(
		folderOptions(folder).todos.list.queryKey(),
	);
	expect(folderOptions(folder).todos.list.queryOptions().queryKey).toEqual(
		folderOptions(folder).todos.list.queryKey(),
	);
	expect(folderOptions(folder).todos.list.queryKey()).not.toEqual(
		folderOptions(other).todos.list.queryKey(),
	);
	// Every table is also under `tables`.
	expect(folderOptions(folder).tables.todos.list.queryKey()).toEqual(
		folderOptions(folder).todos.list.queryKey(),
	);
});

test('pathFilter covers the listing, the files, and history', async () => {
	const folder = await open();
	const other = await open('so.epicenter.querytest.other');
	const folder$ = folderOptions(folder);
	const other$ = folderOptions(other);
	const queryClient = client();
	const keys = {
		list: folder$.todos.list.queryKey(),
		files: folder$.files.list.queryKey(),
		note: folder$.files.read.queryKey('note.txt'),
		noteText: folder$.files.text.queryKey('note.txt'),
		chats: folder$.query({
			paths: ['chats', 'messages'],
			key: ['summaries'],
			queryFn: async () => Ok(1),
		}).queryKey,
		status: folder$.history.status.queryKey(),
		elsewhere: other$.todos.list.queryKey(),
	};
	for (const key of Object.values(keys)) queryClient.setQueryData(key, 1);

	expect(matched(queryClient, folder$.pathFilter(['todos/a.md']))).toEqual([
		keys.list,
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
	// History moved: status, and no file.
	expect(
		matched(queryClient, folder$.pathFilter(['.git/refs/heads/main'])),
	).toEqual([keys.status]);
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

test('a set puts its row in the listing, and marks the rest of its path stale', async () => {
	const { folder$, writes, queryClient } = await openWithMilk();
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	queryClient.setQueryData(folder$.history.status.queryKey(), 'before');
	queryClient.setQueryData(folder$.files.text.queryKey('todos/milk.md'), 1);

	const written = expectOk(
		await writes.tables.todos.set('milk', { done: true }),
	);

	if (!isStoredRow(written)) throw new Error('the set left no row');
	expect(written.row.fields.done).toBe(true);
	const listing = queryClient.getQueryData<TableListing<Todo>>(
		folder$.todos.list.queryKey(),
	);
	expect(listing?.map((item) => item.result.data)).toEqual([written]);
	// The folder does not report the page's own write to it: the write marks
	// what else a change to its file makes stale.
	expect(invalidatedIn(queryClient)).toEqual([
		folder$.history.status.queryKey(),
		folder$.files.text.queryKey('todos/milk.md'),
	]);
});

test('a delete drops the listing entry', async () => {
	const { folder, folder$, writes, queryClient } = await openWithMilk();
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'b', done: false }, body: '' },
			{ stem: 'b' },
		),
	);
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	const stems = () =>
		queryClient
			.getQueryData<{ stem: string }[]>(folder$.todos.list.queryKey())
			?.map((item) => item.stem)
			.sort();

	expectOk(await writes.tables.todos.delete('milk'));
	expect(stems()).toEqual(['b']);
});

test('a read running when a write lands is read again, not kept over the write', async () => {
	const { folder, folder$, writes, queryClient } = await openWithMilk();
	const before = expectOk(await folder.tables.todos.list());
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());
	// A read that answers the listing from before the save, after it lands;
	// a read after it reads the folder.
	let answer = () => {};
	let first = true;
	const late = queryClient
		.fetchQuery({
			...folder$.todos.list.queryOptions(),
			staleTime: 0,
			queryFn: async () => {
				if (!first) return expectOk(await folder.tables.todos.list());
				first = false;
				return new Promise<typeof before>((resolve) => {
					answer = () => resolve(before);
				});
			},
		})
		.catch(() => undefined);
	expectOk(await writes.tables.todos.set('milk', { done: true }));
	// What the write left is held while the read is done again, never what
	// the query held before it.
	const doneOf = () =>
		queryClient
			.getQueryData<TableListing<Todo>>(folder$.todos.list.queryKey())
			?.find((entry) => entry.stem === 'milk')?.result.data?.row.fields.done;
	expect(doneOf()).toBe(true);
	answer();
	await late;
	await queryClient.refetchQueries({ queryKey: folder$.todos.list.queryKey() });
	expect(doneOf()).toBe(true);
});

test('the folder write puts what it wrote in the file read and text, reading nothing back', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const writes = folderWrites(folder, queryClient);
	expectOk(await folder.write('note.txt', null, 'one\n'));
	await queryClient.fetchQuery(folder$.files.read.queryOptions('note.txt'));
	await queryClient.fetchQuery(folder$.files.text.queryOptions('note.txt'));

	const written = expectOk(await writes.write('note.txt', 'one\n', 'two\n'));

	expect(written.file).not.toBeNull();
	expect<unknown>(
		queryClient.getQueryData(folder$.files.read.queryKey('note.txt')),
	).toEqual(written.file);
	expect<unknown>(
		queryClient.getQueryData(folder$.files.text.queryKey('note.txt')),
	).toEqual({ kind: 'text', text: 'two\n' });
	expect(invalidatedIn(queryClient)).toEqual([]);
});

test("the folder write to a row's path marks its listing stale", async () => {
	const { folder$, writes, queryClient, created } = await openWithMilk();
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());

	expectOk(await writes.write(created.path, created.text, null));

	expect(invalidatedIn(queryClient)).toEqual([folder$.todos.list.queryKey()]);
	await queryClient.refetchQueries();
	expect(
		queryClient.getQueryData<TableListing<Todo>>(folder$.todos.list.queryKey()),
	).toEqual([]);
});

test('a move reads both paths again', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const writes = folderWrites(folder, queryClient);
	expectOk(await folder.write('a.txt', null, 'one\n'));
	await queryClient.fetchQuery(folder$.files.list.queryOptions());
	await queryClient.fetchQuery(folder$.files.read.queryOptions('a.txt'));

	const moved = expectOk(await writes.move('a.txt', 'b.txt'));

	expect(moved.path).toBe('b.txt');
	expect(invalidatedIn(queryClient)).toEqual([
		folder$.files.list.queryKey(),
		folder$.files.read.queryKey('a.txt'),
	]);
});

test('a failed write reads its path again and answers the error', async () => {
	const { folder$, writes, queryClient } = await openWithMilk();
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());

	const error = expectErr(
		await writes.tables.todos.set('milk', { done: 'maybe' as never }),
	);
	expect(error.name).toBe('InvalidValues');
	expect(invalidatedIn(queryClient)).toEqual([folder$.todos.list.queryKey()]);
});

test("one row's sets run in the order made, each over the last one's write, and pending counts them", async () => {
	const { folder, writes } = await openWithMilk();
	const read = folder.tables.todos.get;
	const titlesRead: string[] = [];
	folder.tables.todos.get = async (stem) => {
		const result = await read(stem);
		if (result.data) titlesRead.push(result.data.row.fields.title);
		return result;
	};
	const told: number[] = [];
	const stop = writes.subscribe(() =>
		told.push(writes.pending('todos/milk.md')),
	);

	const first = writes.tables.todos.set('milk', { title: 'Oat milk' });
	const second = writes.tables.todos.set('milk', { done: true });
	expect(writes.pending('todos/milk.md')).toBe(2);
	expect(writes.pending()).toBe(2);
	expect(writes.pending('todos/other.md')).toBe(0);
	await writes.idle();
	stop();

	// The second set waited for the first: it read the title it wrote.
	expect(titlesRead).toEqual(['Milk', 'Oat milk']);
	expect(told).toEqual([1, 2, 1, 0]);
	const last = expectOk(await second);
	expect(isStoredRow(last) && last.row.fields).toEqual({
		title: 'Oat milk',
		done: true,
	});
	expectOk(await first);
});

test("work run in a file's turn waits for the writes to it made before", async () => {
	const { writes } = await openWithMilk();
	const order: string[] = [];
	const set = writes.tables.todos
		.set('milk', { done: true })
		.then(() => order.push('set'));
	const work = writes.inTurn('todos/milk.md', async () => {
		order.push('work');
		return 1;
	});
	expect(await work).toBe(1);
	await set;
	expect(order).toEqual(['set', 'work']);
});

test('a create at a generated stem is counted and puts its row in the listing', async () => {
	const folder = await open();
	const folder$ = folderOptions(folder);
	const queryClient = client();
	const writes = folderWrites(folder, queryClient);
	await queryClient.fetchQuery(folder$.todos.list.queryOptions());

	const creating = writes.tables.todos.create({
		fields: { title: 'Milk', done: false },
		body: '',
	});
	expect(writes.pending()).toBe(1);
	const created = expectOk(await creating);
	await writes.idle();

	expect(
		queryClient
			.getQueryData<TableListing<Todo>>(folder$.todos.list.queryKey())
			?.map((entry) => entry.result.data?.path),
	).toEqual([created?.path]);
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
	await queryClient.fetchQuery(reader$.files.text.queryOptions('todos/a.md'));
	await queryClient.fetchQuery(reader$.files.text.queryOptions('todos/b.md'));

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
	expect(invalidated()).toEqual([reader$.files.text.queryKey('todos/a.md')]);
	// Reading again goes through the engine and finds the other page's row.
	const opened = await queryClient.fetchQuery(
		reader$.files.text.queryOptions('todos/a.md'),
	);
	expect(opened.kind === 'text' && opened.text).toContain('A, edited');
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
