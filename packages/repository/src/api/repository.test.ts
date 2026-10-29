/**
 * Repository API Tests
 *
 * The handle a page uses, over a replica in this process: residency
 * declared with the collection, a status gate across worker sessions, an
 * ordered snapshot then deltas, and writes projected until answered.
 *
 * Key behaviors:
 * - A collection kept in memory lists every note whole, invalid ones with their issues; one declared `memory: false` reads one note at a time and through SQL
 * - Writes are refused while no session is open, and project nothing
 * - A write shows at once, is cleared by its answer, and is dropped when it fails
 * - A new session's snapshot keeps the object of every note that did not change
 * - Subscribers hear which collections changed, in memory or not, and the revision moves for SQL reads
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openBunSqlite } from '../bun/sqlite.js';
import { openReplica, type Replica } from '../client/replica.js';
import { defineApp } from '../core/lens.js';
import { createLocalHost } from './local.js';
import { type InvalidNote, type Note, openRepository, type RepositoryChange, type ValidNote } from './repository.js';

const todos = Type.Object({ title: Type.String(), done: Type.Boolean() });
const app = defineApp({
	todos: { path: 'todos/{stem}.md', schema: todos },
	entries: { path: 'journal/{stem}.md', schema: Type.Object({ title: Type.String() }), memory: false },
});
const todo = (title: string, done = false, body = '') => `---\ntitle: ${title}\ndone: ${done}\n---\n${body}`;

/** Let every answer and change in flight arrive. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(seed: (replica: Replica) => void = () => {}) {
	const driver = openBunSqlite();
	const replica = unwrap(openReplica({ driver, binding: { repository: 'r', server: null, account: null }, device: 'laptop', app, after: () => {}, now: () => 0 }));
	seed(replica);
	const local = createLocalHost({ replica, app });
	const repo = openRepository({ app, host: local.host });
	const heard: RepositoryChange[] = [];
	repo.subscribe((change) => heard.push(change));
	return { driver, replica, local, repo, heard };
}

test('a collection kept in memory lists every note whole, invalid ones with their issues', async () => {
	const { repo } = setup((replica) => {
		replica.write('todos/milk.md', todo('Milk', false, 'two litres\n'));
		replica.write('todos/odd.md', '---\ntitle: Odd\n---\n');
		replica.write('todos/broken.md', '---\ntitle: A\ntitle: B\n---\n');
	});
	expect(repo.status()).toEqual({ status: 'opening' });
	expect(repo.todos.all()).toEqual([]);
	await settled();
	expect(repo.status()).toEqual({ status: 'open' });
	const [broken, milk, odd] = repo.todos.all();
	expect(milk).toMatchObject({ path: 'todos/milk.md', params: { stem: 'milk' }, valid: true, fields: { title: 'Milk', done: false }, body: 'two litres\n', text: todo('Milk', false, 'two litres\n') });
	expect(odd).toMatchObject({ valid: false, fields: { title: 'Odd' } });
	expect(odd?.valid === false && odd.issues.length).toBeGreaterThan(0);
	// Narrowed once, a note is one of the two named shapes.
	const named = (note: Note<'todos/{stem}.md', typeof todos>): ValidNote<'todos/{stem}.md', typeof todos> | InvalidNote<'todos/{stem}.md'> => note;
	const titles = repo.todos.all().map(named).map((note) => (note.valid ? note.fields.title : note.issues.length));
	expect(titles).toHaveLength(3);
	expect(broken).toMatchObject({ valid: false, fields: {}, state: { status: 'held' } });
	expect(repo.todos.get({ stem: 'milk' })).toBe(milk);
	// The same array until a note changes.
	expect(repo.todos.all()).toBe(repo.todos.all());
});

test('a collection not kept in memory reads one note at a time and through SQL, and is told when its notes change', async () => {
	const { repo, heard } = setup((replica) => replica.write('journal/2026-01-01.md', '---\ntitle: New year\n---\nCold.\n'));
	await settled();
	// @ts-expect-error a collection not kept in memory has no synchronous reads
	expect(repo.entries.all).toBeUndefined();
	expect(expectOk(await repo.entries.read({ stem: '2026-01-01' }))).toMatchObject({ valid: true, fields: { title: 'New year' }, body: 'Cold.\n' });
	expect(expectOk(await repo.entries.read({ stem: 'missing' }))).toBeNull();
	heard.length = 0;
	const before = repo.revision();
	expectOk(await repo.entries.create({ stem: '2026-01-02' }, { fields: { title: 'Snow' }, body: 'More.\n' }));
	await settled();
	expect(heard.flatMap((change) => change.collections)).toContain('entries');
	expect(repo.revision()).toBeGreaterThan(before);
	expect(expectOk(await repo.query('SELECT stem, title FROM entries ORDER BY stem'))).toEqual([
		{ stem: '2026-01-01', title: 'New year' },
		{ stem: '2026-01-02', title: 'Snow' },
	]);
});

test('writes are refused while no session is open, and project nothing', async () => {
	const { repo, local } = setup((replica) => replica.write('todos/milk.md', todo('Milk')));
	expect(expectErr(await repo.todos.patch({ stem: 'milk' }, { done: true })).name).toBe('Unavailable');
	await settled();
	local.end();
	expect(repo.status()).toEqual({ status: 'opening' });
	expect(expectErr(await repo.todos.create({ stem: 'eggs' }, { fields: { title: 'Eggs', done: false } })).name).toBe('Unavailable');
	expect(repo.todos.all().map((note) => note.params.stem)).toEqual(['milk']);
	expect(expectErr(await repo.query('SELECT 1')).name).toBe('Unavailable');
});

test('a write shows at once, sending, and its answer leaves the note as the worker holds it', async () => {
	const { repo } = setup((replica) => replica.write('todos/milk.md', todo('Milk', false, 'two litres\n')));
	await settled();
	const saving = repo.todos.patch({ stem: 'milk' }, { done: true });
	expect(repo.todos.get({ stem: 'milk' })).toMatchObject({ fields: { done: true }, state: { status: 'sending' } });
	expect(expectOk(await saving)).toMatchObject({ text: todo('Milk', true, 'two litres\n') });
	await settled();
	expect(repo.todos.get({ stem: 'milk' })).toMatchObject({ fields: { done: true }, text: todo('Milk', true, 'two litres\n') });
});

test('a batch that fails is dropped from what shows: nothing of it stays', async () => {
	const { repo, replica } = setup((replica) => replica.write('todos/milk.md', todo('Milk')));
	await settled();
	const saving = repo.commit((batch) => {
		batch.todos.create({ stem: 'eggs' }, { fields: { title: 'Eggs', done: false } });
		batch.todos.patch({ stem: 'gone' }, { done: true });
	});
	expect(repo.todos.get({ stem: 'eggs' })).toMatchObject({ fields: { title: 'Eggs' } });
	expect(expectErr(await saving).name).toBe('NotFound');
	expect(repo.todos.get({ stem: 'eggs' })).toBeUndefined();
	expect(replica.read('todos/eggs.md')).toBeNull();
});

test('a new session keeps the object of every note that did not change, and shows what changed while none was open', async () => {
	const { repo, replica, local, heard } = setup((replica) => {
		replica.write('todos/milk.md', todo('Milk'));
		replica.write('todos/eggs.md', todo('Eggs'));
	});
	await settled();
	const milk = repo.todos.get({ stem: 'milk' });
	const eggs = repo.todos.get({ stem: 'eggs' });
	local.end();
	// While no session is open, the replica changes (another tab's worker, a sync).
	replica.write('todos/eggs.md', todo('Eggs', true));
	replica.write('todos/bread.md', todo('Bread'));
	expect(repo.todos.get({ stem: 'eggs' })).toBe(eggs);
	heard.length = 0;
	local.resume();
	await settled();
	expect(repo.status()).toEqual({ status: 'open' });
	expect(repo.todos.get({ stem: 'milk' })).toBe(milk);
	expect(repo.todos.get({ stem: 'eggs' })).toMatchObject({ fields: { done: true } });
	expect(repo.todos.all().map((note) => note.params.stem)).toEqual(['bread', 'eggs', 'milk']);
	expect(heard.some((change) => change.status && change.collections.includes('todos'))).toBe(true);
});

test("changes made beneath the page arrive in order, and a note's state follows its sync", async () => {
	const { repo, replica } = setup();
	await settled();
	replica.write('todos/milk.md', todo('Milk'));
	replica.write('todos/milk.md', todo('Milk', true));
	await settled();
	expect(repo.todos.get({ stem: 'milk' })).toMatchObject({ fields: { done: true }, state: { status: 'sending' } });
	replica.write('todos/milk.md', null);
	await settled();
	expect(repo.todos.all()).toEqual([]);
});

test('a closed repository refuses writes and lets its host go', async () => {
	const { repo, local } = setup();
	await settled();
	repo.close();
	expect(repo.status()).toEqual({ status: 'closed' });
	expect(expectErr(await repo.todos.create({ stem: 'x' })).name).toBe('Unavailable');
	local.resume();
	expect(repo.status()).toEqual({ status: 'closed' });
});
