/**
 * Reference fields in collections
 *
 * `field.ref(collection)` is the key of a record in another collection. These
 * tests run references through a collection's methods over a memory folder,
 * since that is where a reference's existence check takes effect.
 *
 * Key behaviors:
 * - a reference is stored as the target's key, and `add` and a `set` given
 *   fields refuse it before writing anything unless `get` on the target would
 *   find a record by it whose key it is
 * - a function given to `update` or `set` has what it returns stored
 *   unchecked, as the app's own
 * - a target without exactly one placeholder, or a `.local` one, is refused
 *
 * See also:
 * - `app.types.test.ts` for the type a reference gives
 * - `packages/cli/src/input.test.ts` for a reference on the command line
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import {
	createMemoryContext,
	defineCollection,
	field,
	inRun,
} from './index.ts';

const shelves = defineCollection({
	path: 'data/shelves/{shelf}.md',
	fields: { title: field.text({ optional: true }) },
});

const books = defineCollection({
	path: 'data/books/{book}.md',
	fields: {
		shelf: field.ref(shelves, { optional: true }),
		shelves: field.list(field.ref(shelves)),
	},
});

/** A folder with the shelf `essays` and the book `dune`. */
function setup() {
	return createMemoryContext({
		'data/shelves/essays.md': '---\ntitle: "Essays"\n---\n',
		'data/books/dune.md': '---\n---\nA book\n',
	});
}

/** The message and name a promise rejects with. */
async function refusal(promise: Promise<unknown>) {
	const error = (await promise.then(
		() => undefined,
		(thrown: unknown) => thrown,
	)) as { name?: string; message?: string } | undefined;
	return { name: error?.name, message: error?.message };
}

test('a reference to a record that exists is written, and a read returns its key without opening it', async () => {
	const context = setup();
	await inRun(context, () =>
		books.set({ book: 'dune' }, { shelf: 'essays', shelves: ['essays'] }),
	);
	expect(await context.folder.read('data/books/dune.md')).toBe(
		'---\nshelf: "essays"\nshelves: ["essays"]\n---\nA book\n',
	);
	// A read never checks the key: a record deleted since still reads as its key.
	await context.folder.delete('data/shelves/essays.md');
	const dune = await inRun(context, () => books.get({ book: 'dune' }));
	expect(dune?.shelf).toBe('essays');
	expect(dune?.problems).toBeUndefined();
});

test('add and set refuse a key with no record, writing nothing', async () => {
	const context = setup();
	expect(
		await refusal(
			inRun(context, () => books.add({ book: 'emma', shelf: 'poems' })),
		),
	).toEqual({
		name: 'Refused',
		message:
			'data/books/emma.md: shelf: "poems" names no record in data/shelves/{shelf}.md',
	});
	expect(await context.folder.read('data/books/emma.md')).toBeUndefined();

	const before = await context.folder.read('data/books/dune.md');
	expect(
		await refusal(
			inRun(context, () => books.set({ book: 'dune' }, { shelf: 'poems' })),
		),
	).toEqual({
		name: 'Refused',
		message:
			'data/books/dune.md: shelf: "poems" names no record in data/shelves/{shelf}.md',
	});
	expect(await context.folder.read('data/books/dune.md')).toBe(before);
});

test('a key finds its record as get does, by its exact name first', async () => {
	const context = setup();
	await context.folder.write('data/shelves/Dune  Messiah.md', '---\n---\n');
	expect(
		await inRun(context, () => shelves.get({ shelf: 'Dune  Messiah' })),
	).toMatchObject({ shelf: 'Dune  Messiah' });
	await inRun(context, () =>
		books.set({ book: 'dune' }, { shelf: 'Dune  Messiah' }),
	);
	expect((await inRun(context, () => books.get({ book: 'dune' })))?.shelf).toBe(
		'Dune  Messiah',
	);
});

test('a key that finds a record only by its tidy name is refused, naming the key to write', async () => {
	const context = setup();
	expect(
		await refusal(
			inRun(context, () => books.set({ book: 'dune' }, { shelf: ' essays ' })),
		),
	).toEqual({
		name: 'Refused',
		message:
			'data/books/dune.md: shelf: " essays " is not exactly the key of its record in data/shelves/{shelf}.md; write "essays"',
	});
});

test('a change a function computes, in update or set, is stored without checking references', async () => {
	const context = setup();
	await inRun(context, () =>
		books.update({ book: 'dune' }, () => ({ shelf: 'poems' })),
	);
	await inRun(context, () =>
		books.set({ book: 'dune' }, () => ({ shelves: ['verse'] })),
	);
	expect(await context.folder.read('data/books/dune.md')).toBe(
		'---\nshelf: "poems"\nshelves: ["verse"]\n---\nA book\n',
	);
});

test('a list of references with one key that has no record is refused, naming that key', async () => {
	const context = setup();
	expect(
		await refusal(
			inRun(context, () =>
				books.add({ book: 'emma', shelves: ['essays', 'poems', '../x'] }),
			),
		),
	).toEqual({
		name: 'Refused',
		message: [
			'data/books/emma.md: shelves: "poems" names no record in data/shelves/{shelf}.md',
			'data/books/emma.md: shelves: "../x" is not a key data/shelves/{shelf}.md can name a file by',
		].join('\n'),
	});
	expect(await context.folder.read('data/books/emma.md')).toBeUndefined();
});

test('a reference in a .local collection is refused without quoting its key', async () => {
	const tokens = defineCollection({
		path: 'data/tokens/{name}.local.md',
		fields: { shelf: field.ref(shelves) },
	});
	const context = setup();
	expect(
		await refusal(
			inRun(context, () => tokens.add({ name: 'a', shelf: 'secret-key' })),
		),
	).toEqual({
		name: 'Refused',
		message:
			'data/tokens/a.local.md: shelf names no record in data/shelves/{shelf}.md',
	});
});

test('a target without exactly one placeholder, or a .local target, is refused', () => {
	const two = defineCollection({
		path: 'data/notes/{year}/{id}.md',
		fields: {},
	});
	const one = defineCollection({ path: 'data/settings.md', fields: {} });
	const secrets = defineCollection({
		path: 'data/secrets/{name}.local.md',
		fields: {},
	});
	expect(() => field.ref(two)).toThrow(
		"field.ref names a record by its key, the one placeholder in its collection's path, and data/notes/{year}/{id}.md has 2",
	);
	expect(() => field.ref(one)).toThrow(
		"field.ref names a record by its key, the one placeholder in its collection's path, and data/settings.md has none",
	);
	expect(() => field.ref(secrets)).toThrow(
		'field.ref cannot refer to data/secrets/{name}.local.md',
	);
});

test('a reference is a string schema with the target path, and a description when given', () => {
	expect(
		JSON.parse(
			JSON.stringify(
				Type.Object({ shelf: field.ref(shelves, { description: 'Where' }) }),
			),
		),
	).toEqual({
		type: 'object',
		required: ['shelf'],
		properties: {
			shelf: {
				type: 'string',
				description: 'Where',
				'x-epicenter-ref': { path: 'data/shelves/{shelf}.md' },
			},
		},
	});
});
