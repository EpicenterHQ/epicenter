/**
 * List fields in collections
 *
 * `field.list(item)` is a list of any field. These tests run lists through a
 * collection's methods over a memory folder, since that is where a list's
 * absent value and its items' checks take effect.
 *
 * Key behaviors:
 * - a list reads as `[]` when its line is absent, as absent when its value
 *   does not fit, and is written as JSON
 * - an item that does not fit is refused by what each item must be
 *
 * See also:
 * - `app.types.test.ts` for the types a list gives
 * - `packages/cli/src/input.test.ts` for lists on the command line
 */
import { expect, test } from 'bun:test';
import {
	createMemoryContext,
	defineCollection,
	field,
	inRun,
} from './index.ts';

const books = defineCollection({
	path: 'data/books/{book}.md',
	fields: {
		tags: field.list(field.text()),
		platforms: field.list(field.select(['x', 'threads'])),
		ratings: field.list(field.integer({ min: 1, max: 5 })),
	},
});

/** A folder with the book `dune`, written by hand with no list lines. */
function setup() {
	return createMemoryContext({ 'data/books/dune.md': '---\n---\nA book\n' });
}

test('a list reads as empty when its line is absent', async () => {
	const dune = await inRun(setup(), () => books.get({ book: 'dune' }));
	expect(dune).toEqual({
		path: 'data/books/dune.md',
		book: 'dune',
		tags: [],
		platforms: [],
		ratings: [],
		body: 'A book\n',
	});
});

test('lists of text, select, and number are written as JSON lines', async () => {
	const context = setup();
	await inRun(context, () =>
		books.add({
			book: 'emma',
			tags: ['a', 'b'],
			platforms: ['threads'],
			ratings: [4, 5],
		}),
	);
	expect(await context.folder.read('data/books/emma.md')).toBe(
		'---\ntags: ["a", "b"]\nplatforms: ["threads"]\nratings: [4, 5]\n---\n',
	);
	const [, emma] = await inRun(context, () => books.list());
	expect(emma).toEqual({
		path: 'data/books/emma.md',
		book: 'emma',
		tags: ['a', 'b'],
		platforms: ['threads'],
		ratings: [4, 5],
		body: '',
	});
});

test('a list item that does not fit its field is refused, naming what each must be', async () => {
	const refused = inRun(setup(), () =>
		books.set({ book: 'dune' }, { platforms: ['mastodon'] as never }),
	);
	await expect(refused).rejects.toThrow(
		'data/books/dune.md: platforms: ["mastodon"] is not a list, each one of x, threads',
	);
});
