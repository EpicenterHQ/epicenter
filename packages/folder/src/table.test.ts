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
 *   the row before anything is awaited, and refuses an invalid row before
 *   storage; a create at an occupied stem is `Occupied` and changes
 *   nothing, unless the file holds the same text: a retried create is done
 * - `write` merges the change from one row to another into the row as it is
 *   now, written canonically; another writer landing first starts it again,
 *   and one that never stops is `KeptChanging`
 * - `set` changes the fields it names of the row as it is now, and makes no
 *   row; a write over a row deleted since writes nothing; `delete` removes
 *   whatever is there; `rename` moves the file, row or not, to a vacant
 *   stem, never fusing two rows and carrying a write that lands meanwhile; another writer changing the new stem during the carry stops it as
 *   `InvalidPath`, not `Occupied` (see `save.test.ts` for each over a real directory)
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
import { defineFolder, defineTable, field, parseRow } from './contract.js';
import { hashBytes } from './hash.js';
import { overwrite } from './put.test-support.js';
import type { Row } from './row-text.js';
import { mustRow } from './row-write.test-support.js';
import { createTable } from './table.js';
import { WRITE_ATTEMPTS } from './write.js';

const definition = defineFolder({
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
		// The table reads its rows once it has their names.
		async children(directory: string) {
			const listed = await base.children(directory);
			await beforeReadMany?.();
			return listed;
		},
		async put(...args: Parameters<typeof base.put>) {
			applications++;
			await beforeApply?.();
			return base.put(...args);
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
		await overwrite(base, path, bytes);
		return { path, sha256: await hashBytes(bytes) };
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
		await overwrite(s.base, 'todos/gone.md', null);
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
	const created = mustRow(await s.table.create(row, { stem: 'milk' }));

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
	const created = mustRow(await pending);
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

test('a create at an occupied stem is refused and changes nothing, the same create sent again is done, and a differently cased stem is another file', async () => {
	const s = await setup();
	const first = { ...todo('A', { tags: ['kept'] }), body: 'first\n' };
	const created = mustRow(await s.table.create(first, { stem: 'a' }));
	expect(
		expectErr(
			await s.table.create(
				{ ...todo('Again', { done: true }), body: 'second\n' },
				{ stem: 'a' },
			),
		),
	).toMatchObject({ name: 'Occupied', path: 'todos/a.md' });
	expect(await s.stored('todos/a.md')).toBe(created.text);
	// A retried create finds its own bytes there: done, and nothing written.
	s.resetCounts();
	expect(mustRow(await s.table.create(first, { stem: 'a' }))).toEqual(created);
	expect(s.counts().applications).toBe(0);
	expectOk(await s.table.create(todo('Upper'), { stem: 'A' }));
	expect(expectOk(await s.table.get('A'))?.row.fields.title).toBe('Upper');
	expect(expectOk(await s.table.get('a'))?.row.fields.title).toBe('A');
});

test('a generated stem is used when none is given', async () => {
	const s = await setup();
	const created = mustRow(await s.table.create(todo('A')));
	expect(created.path).toMatch(/^todos\/[0-9a-z]{10}\.md$/);
});

// -- Writes -------------------------------------------------------------------

test('set changes the fields it names of the row as it is now, unknown keys and the body kept', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	s.resetCounts();
	const written = mustRow(await s.table.set('a', { done: true }));
	expect(s.counts().applications).toBe(1);
	expect<unknown>(written.row).toEqual({
		fields: { title: 'External', done: true, tags: [], priority: 'high' },
		body: 'Body\n',
	});
	expect(expectOk(await s.table.get('a'))).toEqual(written);
});

test('set keeps a field another writer changed between its read and its write', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	s.beforeApply(async () => {
		s.beforeApply(undefined);
		await s.put('todos/a.md', VALID.replace('External', 'Theirs'));
	});
	s.resetCounts();
	const written = mustRow(await s.table.set('a', { done: true }));
	expect(s.counts().applications).toBe(2);
	expect(written.row.fields).toMatchObject({ title: 'Theirs', done: true });
});

test('set removes a field set to undefined, and makes no row that is not there', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const removed = mustRow(
		await s.table.set('a', { priority: undefined } as Partial<Todo>),
	);
	expect(removed.row.fields).toEqual({
		title: 'External',
		done: false,
		tags: [],
	});
	expect(
		expectOk(await s.table.set('new', { title: 'New', done: false, tags: [] })),
	).toBeNull();
	expect(await s.stored('todos/new.md')).toBeUndefined();
});

test('set over a file that is not a row, or with a value its field does not admit, is InvalidValues', async () => {
	const s = await setup();
	await s.put('todos/m.md', MALFORMED);
	expect(expectErr(await s.table.set('m', { done: true })).name).toBe(
		'InvalidValues',
	);
	expect(await s.stored('todos/m.md')).toBe(MALFORMED);
	await s.put('todos/a.md', VALID);
	expect(
		expectErr(await s.table.set('a', { title: 7 as never })),
	).toMatchObject({ name: 'InvalidValues', issues: [{ field: 'title' }] });
	expect(await s.stored('todos/a.md')).toBe(VALID);
});

const STYLED =
	'---\r\ntitle: "Kept"   # a comment\r\ndone: false\r\ntags: []\r\npriority: high\r\n---\r\nOne\r\nTwo\r\n';

test('a body write rewrites the frontmatter in the standard form and the body with line feeds', async () => {
	const s = await setup();
	await s.put('todos/a.md', STYLED);
	const stored = await s.row('a');
	const written = mustRow(
		await s.table.write('a', stored.row, {
			...stored.row,
			body: 'One\nTwo\nThree\n',
		}),
	);
	expect(await s.stored('todos/a.md')).toBe(
		'---\ntitle: Kept\ndone: false\ntags: []\npriority: high\n---\nOne\nTwo\nThree\n',
	);
	expect(written.row.body).toBe('One\nTwo\nThree\n');
});

test('a write that changes nothing leaves a styled CRLF row byte for byte', async () => {
	const s = await setup();
	await s.put('todos/a.md', STYLED);
	const stored = await s.row('a');
	mustRow(await s.table.write('a', stored.row, stored.row));
	expect(await s.stored('todos/a.md')).toBe(STYLED);
});

test('a write keeps fields and lines another writer changed, and wins lines both changed', async () => {
	const s = await setup();
	const at = (title: string, body: string) =>
		`---\ntitle: ${title}\ndone: false\ntags: []\n---\n${body}`;
	await s.put('todos/a.md', at('A', 'one\ntwo\nthree\n'));
	const stored = await s.row('a');
	await s.put('todos/a.md', at('Theirs', 'one\nTWO (theirs)\nthree\nadded\n'));
	const written = mustRow(
		await s.table.write('a', stored.row, {
			...stored.row,
			body: 'ONE\nTWO (mine)\nthree\n',
		}),
	);
	expect(written.row).toEqual({
		fields: { title: 'Theirs', done: false, tags: [] },
		body: 'ONE\nTWO (mine)\nthree\nadded\n',
	});
});

test('a write over a row deleted since it started writes nothing: the delete stands', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const stored = await s.row('a');
	await overwrite(s.base, 'todos/a.md', null);
	expect(
		expectOk(
			await s.table.write('a', stored.row, { ...stored.row, body: 'Back\n' }),
		),
	).toBeNull();
	expect(await s.stored('todos/a.md')).toBeUndefined();
});

test("every attempt merges from the write's own from, and the write logs what the last one overwrote", async () => {
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
		const mine = {
			...stored.row,
			fields: { ...stored.row.fields, title: 'Mine' },
		};
		const written = mustRow(await s.table.write('a', stored.row, mine));
		expect(written.row.fields.title).toBe('Mine');
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

test('a row that keeps changing gives up after the bounded attempts, writing nothing of its own', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	let writes = 0;
	// Another writer lands before every attempt, so each one is overtaken.
	s.beforeApply(async () => {
		await s.put('todos/a.md', NEWER.replace('Newer', `Newer ${writes++}`));
	});
	const refused = expectErr(await s.table.set('a', { title: 'Mine' }));
	s.beforeApply(undefined);
	expect(refused).toMatchObject({
		name: 'KeptChanging',
		path: 'todos/a.md',
		attempts: WRITE_ATTEMPTS,
	});
	expect(writes).toBe(WRITE_ATTEMPTS);
	expect(await s.stored('todos/a.md')).toContain(`Newer ${WRITE_ATTEMPTS - 1}`);
});

test('delete removes whatever is at the stem, a row or not, and a gone row is done', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/m.md', MALFORMED);
	for (const { stem } of expectOk(await s.table.list()))
		expectOk(await s.table.delete(stem));
	expect(expectOk(await s.table.list())).toEqual([]);
	expectOk(await s.table.delete('a'));
});

test('rename moves the row file to a vacant stem, a file that is not a row as it is', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/m.md', MALFORMED);
	const moved = mustRow(await s.table.rename('a', 'b'));
	expect(moved.path).toBe('todos/b.md');
	expect(await s.stored('todos/a.md')).toBeUndefined();
	expect(await s.stored('todos/b.md')).toBe(VALID);
	// The moved file does not read as a row, and the rename answers it as it is.
	expect(expectOk(await s.table.rename('m', 'n'))).toMatchObject({
		name: 'InvalidRow',
		path: 'todos/n.md',
		text: MALFORMED,
	});
	expect(await s.stored('todos/n.md')).toBe(MALFORMED);
	expect(await s.stored('todos/m.md')).toBeUndefined();
});

test('two renames onto one stem never fuse two rows: one moves, the other is Occupied', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/b.md', NEWER);
	const [first, second] = await Promise.all([
		s.table.rename('a', 'c'),
		s.table.rename('b', 'c'),
	]);
	const outcomes = [first, second].map((result) =>
		result.error === null ? 'moved' : result.error.name,
	);
	expect(outcomes.sort()).toEqual(['Occupied', 'moved']);
	const moved = first.error === null ? VALID : NEWER;
	const stayed = first.error === null ? 'todos/b.md' : 'todos/a.md';
	expect(await s.stored('todos/c.md')).toBe(moved);
	expect(await s.stored(stayed)).toBe(first.error === null ? NEWER : VALID);
});

test('a write that lands at the old stem during a rename is carried to the new one', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	let raced = false;
	// Another writer lands at the old stem once the bytes reached the new one.
	s.beforeApply(async () => {
		if (raced || (await s.stored('todos/b.md')) === undefined) return;
		raced = true;
		await s.put('todos/a.md', NEWER);
	});
	const moved = mustRow(await s.table.rename('a', 'b'));
	s.beforeApply(undefined);
	expect(raced).toBe(true);
	expect(moved.text).toBe(NEWER);
	expect(await s.stored('todos/b.md')).toBe(NEWER);
	expect(await s.stored('todos/a.md')).toBeUndefined();
});

test('a write at the new stem during a rename stops it there, and the answer says both stems may hold the row', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	const OTHER = VALID.replace('External', 'Other');
	let raced = false;
	// Once the bytes reached the new stem, one writer lands at the old stem
	// and another edits the copy at the new one.
	s.beforeApply(async () => {
		if (raced || (await s.stored('todos/b.md')) === undefined) return;
		raced = true;
		await s.put('todos/a.md', NEWER);
		await s.put('todos/b.md', OTHER);
	});
	const stopped = expectErr(await s.table.rename('a', 'b'));
	// Not `Occupied`: the new stem held nothing before the move, and the
	// move left a copy there that another writer edited.
	expect(stopped).toMatchObject({ name: 'InvalidPath', path: 'todos/b.md' });
	expect(stopped.message).toContain('the file stays at its old path');
	s.beforeApply(undefined);
	expect(raced).toBe(true);
	expect(await s.stored('todos/a.md')).toBe(NEWER);
	expect(await s.stored('todos/b.md')).toBe(OTHER);
});

test('a delete at the new stem during a rename stops it there, and the answer does not say a file is there', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	let raced = false;
	// Once the bytes reached the new stem, one writer lands at the old stem
	// and another deletes the copy at the new one.
	s.beforeApply(async () => {
		if (raced || (await s.stored('todos/b.md')) === undefined) return;
		raced = true;
		await s.put('todos/a.md', NEWER);
		await overwrite(s.base, 'todos/b.md', null);
	});
	const stopped = expectErr(await s.table.rename('a', 'b'));
	expect(stopped).toMatchObject({ name: 'InvalidPath', path: 'todos/b.md' });
	expect(stopped.message).toContain('holds what that writer left, if anything');
	s.beforeApply(undefined);
	expect(raced).toBe(true);
	expect(await s.stored('todos/a.md')).toBe(NEWER);
	expect(await s.stored('todos/b.md')).toBeUndefined();
});

test('a delete of the old stem during a rename stands: the row is at neither stem', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	let raced = false;
	// The row is deleted once its bytes reached the new stem.
	s.beforeApply(async () => {
		if (raced || (await s.stored('todos/b.md')) === undefined) return;
		raced = true;
		await overwrite(s.base, 'todos/a.md', null);
	});
	expect(expectErr(await s.table.rename('a', 'b')).name).toBe('InvalidPath');
	s.beforeApply(undefined);
	expect(raced).toBe(true);
	expect(await s.stored('todos/a.md')).toBeUndefined();
	expect(await s.stored('todos/b.md')).toBeUndefined();
});

test('rename from a stem with no file is InvalidPath, onto an occupied one Occupied, and changes nothing', async () => {
	const s = await setup();
	await s.put('todos/a.md', VALID);
	await s.put('todos/b.md', NEWER);
	expect(expectErr(await s.table.rename('gone', 'c')).name).toBe('InvalidPath');
	expect(expectErr(await s.table.rename('a', 'b')).name).toBe('Occupied');
	expect(await s.stored('todos/a.md')).toBe(VALID);
	expect(await s.stored('todos/b.md')).toBe(NEWER);
	expect(mustRow(await s.table.rename('a', 'a')).path).toBe('todos/a.md');
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
		expect(expectErr(await s.table.set(stem, { done: true })).name).toBe(
			'InvalidPath',
		);
		expect(expectErr(await s.table.delete(stem)).name).toBe('InvalidPath');
	}
	expect(s.counts()).toEqual({ reads: 0, applications: 0 });
});
