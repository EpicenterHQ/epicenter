/**
 * File Table Tests
 *
 * Exercises a table over browser OPFS publication, through the in-memory
 * stand-in, with competing writes at the boundary. Every read goes through
 * `parseRow` and every write through `formatRow`, so these tests check what
 * a caller holds after each operation and which bytes the folder holds.
 *
 * Key behaviors:
 * - `get` is a `StoredRow`: the path and hash of the bytes read, their text,
 *   and the complete row, unknown keys included; only absence is `undefined`
 * - Text that is not a valid row is `InvalidRow` with the exact text, the
 *   hash of its bytes, and located issues; bytes that are not UTF-8 are
 *   `InvalidUtf8` with their hash
 * - A stored row's capture is frozen; its row is the caller's own, mutable,
 *   and shared with no other read
 * - `list` has one item per `.md` file with its own Result, through the same
 *   pipeline as `get`
 * - `create` writes canonical text that reads back as the same row, captures
 *   the row before anything is awaited, refuses an invalid row before
 *   storage, and refuses an occupied path
 * - `save`, `rename`, and `delete` take a capture: a stored row, an
 *   `InvalidRow`, or a listed row. `rename` and `delete` over different or
 *   missing bytes are `Conflict`; `save` over different bytes merges (see
 *   `save.test.ts`), and over missing ones is `NotFound`. A missing row is
 *   never recreated
 * - Every literal single-segment stem is an address, the empty one included;
 *   only the exact lowercase `.md` extension is a row
 *
 * See also:
 * - `row-text.test.ts` for parsing, formatting, and issue locations
 * - `native.test.ts` for the same table over a real directory
 */
import { expect, spyOn, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { rawBrowserFolder } from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field, parseRow } from './contract.js';
import type { Row } from './row-text.js';
import { WRITE_ATTEMPTS } from './save-file.js';
import { createTable } from './table.js';

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				done: field.boolean(),
				tags: field.tags(),
			},
		}),
		bare: defineTable({ fields: {} }),
	},
});
type Todo = { title: string; done: boolean; tags: string[] };

const encoder = new TextEncoder();
// A byte-order mark is part of the stored text, so it is not stripped here.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

const todo = (title: string, extra: Partial<Todo> = {}): Row<Todo> => ({
	fields: { title, done: false, tags: [], ...extra },
	body: '',
});

async function setup() {
	const base = (await rawBrowserFolder({ id: 'table.rows' })).boundary;
	let beforeReadMany: (() => Promise<void>) | undefined;
	let beforeApply: (() => Promise<void>) | undefined;
	let reads = 0;
	let applications = 0;
	const storage = {
		...base,
		read(path: string) {
			reads++;
			return base.read(path);
		},
		async readMany(paths: readonly string[]) {
			await beforeReadMany?.();
			return base.readMany(paths);
		},
		async apply(changes: Parameters<typeof base.apply>[0]) {
			applications++;
			await beforeApply?.();
			return base.apply(changes);
		},
	};
	const table = createTable<Todo>(
		{ storage },
		'todos',
		definition.tables.todos,
	);
	/** Put exact bytes at a path without going through the table. */
	async function put(path: string, content: string | Uint8Array) {
		const bytes =
			typeof content === 'string' ? encoder.encode(content) : content;
		const sha256 = await hashBytes(bytes);
		expectOk(await base.apply([{ kind: 'overwrite', path, bytes, sha256 }]));
		return { path, sha256 };
	}
	return {
		table,
		base,
		storage,
		put,
		counts: () => ({ reads, applications }),
		resetCounts() {
			reads = 0;
			applications = 0;
		},
		beforeReadMany(fn: () => Promise<void>) {
			beforeReadMany = fn;
		},
		beforeApply(fn: (() => Promise<void>) | undefined) {
			beforeApply = fn;
		},
		/** The stored row at a stem that is known to be there. */
		async row(stem: string) {
			const stored = expectOk(await table.get(stem));
			if (stored === undefined) throw new Error(`no row at '${stem}'`);
			return stored;
		},
		async stored(path: string) {
			const read = await base.read(path);
			return read.error === null ? decoder.decode(read.data.bytes) : undefined;
		},
	};
}

const VALID =
	'---\ntitle: External\ndone: false\ntags: []\npriority: high\n---\nBody\n';
const MALFORMED = '---\ntitle: [unfinished\n---\ndraft\n';
const NONCONFORMING = '---\ntitle: A\ndone: maybe\ntags: []\n---\n';
const NEWER = '---\ntitle: Newer\ndone: false\ntags: []\n---\n';

// -- Reading ------------------------------------------------------------------

test('a stored row is the bytes it was read from and the complete row they hold', async () => {
	const s = await setup();
	const file = await s.put('todos/a.md', VALID);
	expect<unknown>(expectOk(await s.table.get('a'))).toEqual({
		path: 'todos/a.md',
		sha256: file.sha256,
		text: VALID,
		row: {
			fields: { title: 'External', done: false, tags: [], priority: 'high' },
			body: 'Body\n',
		},
	});
	expect(expectOk(await s.table.get('missing'))).toBeUndefined();
});

test('a stored row’s capture is frozen, and its row is the caller’s own', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const first = await s.row('a');
	const second = await s.row('a');
	expect(Object.isFrozen(first)).toBe(true);

	first.row.fields.title = 'Edited';
	first.row.fields.tags.push('x');
	first.row.body = 'changed';

	expect(second.row.fields.title).toBe('External');
	expect(second.row.fields.tags).toEqual([]);
	expect(second.row.body).toBe('Body\n');
});

test('text that is not a valid row is InvalidRow with its exact text, hash, and located issues', async () => {
	const s = await setup();
	const malformed = await s.put('todos/m.md', MALFORMED);
	const error = expectErr(await s.table.get('m'));
	expect(error).toMatchObject({
		name: 'InvalidRow',
		path: 'todos/m.md',
		sha256: malformed.sha256,
		text: MALFORMED,
	});
	if (error.name !== 'InvalidRow') return;
	// The parser notices the unclosed `[` where the frontmatter ends, as a
	// compiler reports an unexpected end of input.
	expect(error.issues).toHaveLength(1);
	expect(error.issues[0]?.line).toBe(3);

	await s.put('todos/n.md', NONCONFORMING);
	expect(expectErr(await s.table.get('n'))).toMatchObject({
		name: 'InvalidRow',
		text: NONCONFORMING,
		issues: [{ field: 'done', line: 3 }],
	});
});

test('bytes that are not UTF-8 are InvalidUtf8 with the hash of what was read', async () => {
	const s = await setup();
	const file = await s.put('todos/b.md', new Uint8Array([0x2d, 0xff, 0xfe]));
	expect(expectErr(await s.table.get('b'))).toMatchObject({
		name: 'InvalidUtf8',
		path: 'todos/b.md',
		sha256: file.sha256,
	});
});

// -- Listing ------------------------------------------------------------------

test('a listing has one item per row file, each read through the same pipeline as get', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/m.md', MALFORMED);
	await s.put('todos/upper.MD', VALID);
	await s.put('todos/notes.txt', 'not a row');
	const listing = expectOk(await s.table.list());
	const byStem = Object.fromEntries(
		listing.map(({ stem, result }) => [stem, result]),
	);
	expect(Object.keys(byStem).sort()).toEqual(['a', 'm']);
	expect(byStem.a).toEqual(Ok(await s.row('a')));
	expect(byStem.m?.error?.name).toBe('InvalidRow');
});

test('a file that goes away after it was enumerated is its own NotFound', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/gone.md', VALID);
	s.beforeReadMany(async () => {
		expectOk(await s.base.apply([{ kind: 'remove', path: 'todos/gone.md' }]));
	});
	const listing = expectOk(await s.table.list());
	expect(listing.find(({ stem }) => stem === 'gone')?.result.error?.name).toBe(
		'NotFound',
	);
	expect(listing.find(({ stem }) => stem === 'a')?.result.error).toBeNull();
});

test('a missing table directory lists as empty', async () => {
	const s = await setup();
	expect(expectOk(await s.table.list())).toEqual([]);
});

// -- Creating -----------------------------------------------------------------

test('create writes canonical text that reads back as the same row', async () => {
	const s = await setup();
	const row = todo('Milk', { tags: ['home'] });
	(row.fields as Record<string, unknown>).priority = 'high';
	row.body = 'Two percent.\n';
	const created = expectOk(await s.table.create(row, { stem: 'milk' }));

	const text = await s.stored('todos/milk.md');
	expect(text).toBe(
		'---\ntitle: Milk\ndone: false\ntags:\n  - home\npriority: high\n---\nTwo percent.\n',
	);
	expect(created.sha256).toBe(await hashBytes(encoder.encode(text)));
	expect(expectOk(await s.table.get('milk'))).toEqual(created);
	expect(expectOk(parseRow(definition.tables.todos, text ?? ''))).toEqual(
		created.row,
	);
});

test('create captures the row before anything is awaited', async () => {
	const s = await setup();
	const row = todo('Before');
	const pending = s.table.create(row, { stem: 'c' });
	row.fields.title = 'After';
	row.fields.tags.push('late');
	const created = expectOk(await pending);
	expect(created.row.fields).toEqual({
		title: 'Before',
		done: false,
		tags: [],
	});
	expect(created.row).not.toBe(row);
});

test('a new row always has both fences, even with no fields and no body', async () => {
	const s = await setup();
	const bare = createTable<Record<string, never>>(
		{ storage: s.storage },
		'bare',
		definition.tables.bare,
	);
	expectOk(await bare.create({ fields: {}, body: '' }, { stem: 'x' }));
	expect(await s.stored('bare/x.md')).toBe('---\n---\n');
});

test('an invalid or unrepresentable row is refused before anything touches storage', async () => {
	const s = await setup();
	s.resetCounts();
	expect(
		expectErr(
			await s.table.create(
				{ fields: { title: 'A', done: 'maybe' as never, tags: [] }, body: '' },
				{ stem: 'v' },
			),
		),
	).toMatchObject({ name: 'InvalidValues', issues: [{ field: 'done' }] });
	expect(
		expectErr(
			await s.table.create(todo('A', { tags: [Number.NaN as never] }), {
				stem: 'w',
			}),
		),
	).toMatchObject({ name: 'InvalidValues', issues: [{ field: 'tags' }] });
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(expectOk(await s.table.list())).toEqual([]);
});

test('an occupied path is Exists, and a differently cased stem is another file', async () => {
	const s = await setup();
	expectOk(await s.table.create(todo('A'), { stem: 'a' }));
	expect(
		expectErr(await s.table.create(todo('Again'), { stem: 'a' })),
	).toMatchObject({ name: 'Exists', path: 'todos/a.md' });
	expectOk(await s.table.create(todo('Upper'), { stem: 'A' }));
	expect(expectOk(await s.table.get('A'))?.row.fields.title).toBe('Upper');
	expect(expectOk(await s.table.get('a'))?.row.fields.title).toBe('A');
});

test('a generated stem is used when none is given', async () => {
	const s = await setup();
	const created = expectOk(await s.table.create(todo('A')));
	expect(created.path).toMatch(/^todos\/[0-9a-z]{10}\.md$/);
});

// -- Guarded writes -----------------------------------------------------------

test('save writes a row over the bytes it was read from, reading nothing', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	stored.row.fields.done = true;
	s.resetCounts();
	const replaced = expectOk(await s.table.save(stored, stored.row)).stored;
	expect(s.counts()).toEqual({ reads: 0, applications: 1 });
	expect<unknown>(replaced.row.fields).toEqual({
		title: 'External',
		done: true,
		tags: [],
		priority: 'high',
	});
	expect(expectOk(await s.table.get('a'))).toEqual(replaced);
});

test('save against bytes that changed merges with them, keeping what only they changed', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	await s.put('todos/a.md', NEWER);
	const edited = structuredClone(stored.row);
	edited.fields.done = true;
	const saved = expectOk(await s.table.save(stored, edited));
	expect(saved.merged).toBe(true);
	expect<unknown>(expectOk(await s.table.get('a'))?.row).toEqual({
		fields: { title: 'Newer', done: true, tags: [] },
		body: '',
	});
});

test('a missing row is never recreated by a guarded write', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	expectOk(await s.base.apply([{ kind: 'remove', path: 'todos/a.md' }]));
	expect(expectErr(await s.table.save(stored, todo('Back'))).name).toBe(
		'NotFound',
	);
	expect(await s.stored('todos/a.md')).toBeUndefined();
});

test('an invalid row is repaired with its own capture', async () => {
	const s = await setup();
	await s.put('todos/m.md', MALFORMED);
	const invalid = expectErr(await s.table.get('m'));
	if (invalid.name !== 'InvalidRow') throw new Error(invalid.message);
	expectOk(await s.table.save(invalid, todo('Repaired'))).stored;
	expect(expectOk(await s.table.get('m'))?.row.fields.title).toBe('Repaired');
});

test('save refuses an invalid row before anything touches storage', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	s.resetCounts();
	expect(
		expectErr(
			await s.table.save(stored, {
				fields: { title: 7 as never, done: false, tags: [] },
				body: '',
			}),
		),
	).toMatchObject({ name: 'InvalidValues' });
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(await s.stored('todos/a.md')).toBe(VALID);
});

test('a capture that is not a row file of this table is InvalidPath before storage', async () => {
	const s = await setup();
	const sha256 = '0'.repeat(64);
	s.resetCounts();
	for (const path of ['other/a.md', 'todos/a.txt', 'todos/nested/a.md'])
		expect(expectErr(await s.table.delete({ path, sha256 })).name).toBe(
			'InvalidPath',
		);
	expect(
		expectErr(await s.table.delete({ path: 'todos/a.md', sha256: 'nope' }))
			.name,
	).toBe('InvalidPath');
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

test('rename moves the captured row to a vacant stem and returns its capture there', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	expect(expectOk(await s.table.rename(stored, 'b'))).toEqual({
		path: 'todos/b.md',
		sha256: stored.sha256,
	});
	expect(await s.stored('todos/a.md')).toBeUndefined();
	expect(await s.stored('todos/b.md')).toBe(VALID);
});

test('rename to its own stem is InvalidPath and to an occupied stem is Exists', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/b.md', VALID);
	const stored = await s.row('a');
	s.resetCounts();
	expect(expectErr(await s.table.rename(stored, 'a')).name).toBe('InvalidPath');
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
	expect(expectErr(await s.table.rename(stored, 'b')).name).toBe('Exists');
	expect(await s.stored('todos/a.md')).toBe(VALID);
});

test('rename and delete of bytes that changed are Conflict and change nothing', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	await s.put('todos/a.md', NEWER);
	expect(expectErr(await s.table.rename(stored, 'b')).name).toBe('Conflict');
	expect(expectErr(await s.table.delete(stored)).name).toBe('Conflict');
	expect(await s.stored('todos/a.md')).toBe(NEWER);
	expect(await s.stored('todos/b.md')).toBeUndefined();
});

test('delete removes the captured row, a listed or invalid one included', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/m.md', MALFORMED);
	for (const { result } of expectOk(await s.table.list())) {
		const capture = result.error === null ? result.data : result.error;
		if (!('sha256' in capture)) throw new Error('every item here was read');
		expectOk(await s.table.delete(capture));
	}
	expect(expectOk(await s.table.list())).toEqual([]);
});

test('a save that races a competing write merges over it once, and the edit wins', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	s.beforeApply(async () => {
		s.beforeApply(undefined);
		await s.put('todos/a.md', NEWER);
	});
	s.resetCounts();
	const saved = expectOk(await s.table.save(stored, todo('Mine')));
	expect(s.counts().applications).toBe(2);
	expect(saved.merged).toBe(true);
	expect(saved.stored.row.fields.title).toBe('Mine');
	expect(expectOk(await s.table.get('a'))?.row.fields.title).toBe('Mine');
});

test("every merge round starts from the edit's own base, so a save logs what the last round overwrote", async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	let writes = 0;
	// Two other writers land, one before each of the first two attempts.
	s.beforeApply(async () => {
		if (writes === 2) return s.beforeApply(undefined);
		await s.put('todos/a.md', NEWER.replace('Newer', `Newer ${writes++}`));
	});
	const logged = spyOn(console, 'info').mockImplementation(() => {});
	try {
		const saved = expectOk(await s.table.save(stored, todo('Mine')));
		expect(saved.stored.row.fields.title).toBe('Mine');
		// One line for the save that landed, naming the last round's units.
		expect(logged.mock.calls).toEqual([
			[
				'[folder/save]',
				"Saved over another writer's change to todos/a.md",
				{
					path: 'todos/a.md',
					units: [{ kind: 'field', field: 'title' }],
				},
			],
		]);
	} finally {
		logged.mockRestore();
	}
});

test('a row that keeps changing gives up after the bounded merges, writing nothing of its own', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	let writes = 0;
	// Another writer lands before every attempt, so each merge is overtaken.
	s.beforeApply(async () => {
		await s.put('todos/a.md', NEWER.replace('Newer', `Newer ${writes++}`));
	});
	const refused = expectErr(await s.table.save(stored, todo('Mine')));
	s.beforeApply(undefined);
	expect(refused).toMatchObject({
		name: 'KeptChanging',
		path: 'todos/a.md',
		attempts: WRITE_ATTEMPTS,
	});
	expect(writes).toBe(WRITE_ATTEMPTS + 1);
	expect(await s.stored('todos/a.md')).toContain(`Newer ${WRITE_ATTEMPTS}`);
});

// -- Addresses ----------------------------------------------------------------

test('every literal single-segment stem is an address, the empty one included', async () => {
	const s = await setup();
	const stems = ['', ' ', 'a b', 'ünïcode', '.hidden', 'a.b'];
	for (const stem of stems)
		expectOk(await s.table.create(todo(`stem ${stem}`), { stem }));
	for (const stem of stems)
		expect(expectOk(await s.table.get(stem))?.path).toBe(`todos/${stem}.md`);
});

test('a stem that is not one segment is InvalidPath before storage', async () => {
	const s = await setup();
	s.resetCounts();
	for (const stem of ['a/b', '../a']) {
		expect(expectErr(await s.table.get(stem)).name).toBe('InvalidPath');
		expect(expectErr(await s.table.create(todo('x'), { stem })).name).toBe(
			'InvalidPath',
		);
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});

// -- Body writes (ADR-0575) ------------------------------------------------------

const STYLED =
	'---\r\ntitle: "Kept"   # a comment\r\ndone: false\r\ntags: []\r\npriority: high\r\n---\r\nOne\r\nTwo\r\n';

test('setBody keeps every byte before the body and writes the body with line feeds', async () => {
	const s = await setup();
	await s.put('todos/a.md', STYLED);
	const stored = await s.row('a');
	const saved = expectOk(await s.table.setBody(stored, 'One\nTwo\nThree\n'));
	expect(saved.merged).toBe(false);
	const head = STYLED.slice(0, STYLED.indexOf('---\r\n', 4) + 5);
	expect(await s.stored('todos/a.md')).toBe(`${head}One\nTwo\nThree\n`);
	expect(saved.stored.row.body).toBe('One\nTwo\nThree\n');
	expect(saved.stored.row.fields).toMatchObject({ title: 'Kept', priority: 'high' });
});

test('setBody keeps fields another writer changed and merges the body by line', async () => {
	const s = await setup();
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---\none\ntwo\nthree\n');
	const stored = await s.row('a');
	await s.put('todos/a.md', '---\ntitle: Renamed\ndone: true\ntags: []\n---\none\ntwo\nthree\nfour\n');
	const saved = expectOk(await s.table.setBody(stored, 'ONE\ntwo\nthree\n'));
	expect(saved.merged).toBe(true);
	expect<unknown>(expectOk(await s.table.get('a'))?.row).toEqual({
		fields: { title: 'Renamed', done: true, tags: [] },
		body: 'ONE\ntwo\nthree\nfour\n',
	});
});

test('setBody wins lines both changed', async () => {
	const s = await setup();
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---\none\n');
	const stored = await s.row('a');
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---\ntheirs\n');
	const saved = expectOk(await s.table.setBody(stored, 'mine\n'));
	expect(saved).toMatchObject({ merged: true, stored: { row: { body: 'mine\n' } } });
	expect(await s.stored('todos/a.md')).toBe(
		'---\ntitle: A\ndone: false\ntags: []\n---\nmine\n',
	);
});

test('setBody with ifUnchanged refuses a body another writer changed, writing nothing', async () => {
	const s = await setup();
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---\none\n');
	const stored = await s.row('a');
	const theirs = '---\ntitle: A\ndone: false\ntags: []\n---\ntheirs\n';
	await s.put('todos/a.md', theirs);
	s.resetCounts();
	const refused = expectErr(
		await s.table.setBody(stored, 'mine\n', { ifUnchanged: true }),
	);
	expect(refused).toMatchObject({
		name: 'Conflict',
		path: 'todos/a.md',
		expectedSha256: stored.sha256,
		actualSha256: await hashBytes(encoder.encode(theirs)),
	});
	expect(s.counts().applications).toBe(0);
	expect(await s.stored('todos/a.md')).toBe(theirs);
});

test('setBody with ifUnchanged writes over a change to the fields alone, keeping it', async () => {
	const s = await setup();
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---\none\n');
	const stored = await s.row('a');
	await s.put('todos/a.md', '---\ntitle: Renamed\ndone: true\ntags: []\n---\none\n');
	const saved = expectOk(
		await s.table.setBody(stored, 'mine\n', { ifUnchanged: true }),
	);
	expect(saved.merged).toBe(false);
	expect(await s.stored('todos/a.md')).toBe(
		'---\ntitle: Renamed\ndone: true\ntags: []\n---\nmine\n',
	);
});

test('setBody with ifUnchanged writes as usual over an unchanged file', async () => {
	const s = await setup();
	await s.put('todos/a.md', STYLED);
	const stored = await s.row('a');
	const saved = expectOk(
		await s.table.setBody(stored, 'One\nTwo\nThree\n', { ifUnchanged: true }),
	);
	expect(saved.merged).toBe(false);
	const head = STYLED.slice(0, STYLED.indexOf('---\r\n', 4) + 5);
	expect(await s.stored('todos/a.md')).toBe(`${head}One\nTwo\nThree\n`);
});

test('setBody writes nothing when the body would not change', async () => {
	const s = await setup();
	await s.put('todos/a.md', STYLED);
	const stored = await s.row('a');
	s.resetCounts();
	const saved = expectOk(await s.table.setBody(stored, 'One\r\nTwo\r\n'));
	expect(saved.stored.sha256).toBe(stored.sha256);
	expect(s.counts().applications).toBe(0);
	expect(await s.stored('todos/a.md')).toBe(STYLED);
});

test('setBody puts a line break after a closing fence with none', async () => {
	const s = await setup();
	await s.put('todos/a.md', '---\ntitle: A\ndone: false\ntags: []\n---');
	const stored = await s.row('a');
	expectOk(await s.table.setBody(stored, 'Body\n'));
	expect(await s.stored('todos/a.md')).toBe(
		'---\ntitle: A\ndone: false\ntags: []\n---\nBody\n',
	);
});

test('setBody never recreates a deleted row and refuses a file that is not a row', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	expectOk(await s.base.apply([{ kind: 'remove', path: 'todos/a.md' }]));
	expect(expectErr(await s.table.setBody(stored, 'x\n')).name).toBe('NotFound');
	expect(await s.stored('todos/a.md')).toBeUndefined();

	await s.put('todos/a.md', VALID);
	const again = await s.row('a');
	await s.put('todos/a.md', 'no frontmatter at all\n');
	expect(expectErr(await s.table.setBody(again, 'x\n')).name).toBe('InvalidRow');
	await s.put('todos/a.md', MALFORMED);
	expect(expectErr(await s.table.setBody(again, 'x\n')).name).toBe('InvalidRow');
	expect(await s.stored('todos/a.md')).toBe(MALFORMED);
});

test('setBody gives up after the bounded attempts when the file keeps changing', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	let n = 0;
	s.beforeApply(async () => {
		s.beforeApply(undefined);
		await s.put('todos/a.md', `${VALID}${n++}\n`);
		s.beforeApply(async function again() {
			s.beforeApply(undefined);
			await s.put('todos/a.md', `${VALID}${n++}\n`);
			s.beforeApply(again);
		});
	});
	expect(expectErr(await s.table.setBody(stored, 'mine\n'))).toMatchObject({
		name: 'KeptChanging',
		attempts: WRITE_ATTEMPTS,
	});
});
