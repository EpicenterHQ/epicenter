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
 * - a list with `min` is required: its schema has `minItems`, an absent one
 *   is missing rather than `[]`, and an action's call does not fill it
 *
 * See also:
 * - `app.types.test.ts` for the types a list gives
 * - `packages/cli/src/input.test.ts` for lists on the command line
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { ActionError } from './errors.ts';
import {
	createMemoryContext,
	defineAction,
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
	expect(dune).toEqual(
		Ok({
			path: 'data/books/dune.md',
			book: 'dune',
			tags: [],
			platforms: [],
			ratings: [],
			body: 'A book\n',
		}),
	);
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
	expect(emma).toEqual(
		Ok({
			path: 'data/books/emma.md',
			book: 'emma',
			tags: ['a', 'b'],
			platforms: ['threads'],
			ratings: [4, 5],
			body: '',
		}),
	);
});

test('a list item that does not fit its field is refused, naming what each must be', async () => {
	const refused = inRun(setup(), () =>
		books.set({ book: 'dune' }, { platforms: ['mastodon'] as never }),
	);
	await expect(refused).resolves.toMatchObject({
		error: {
			message: expect.stringContaining(
				'data/books/dune.md: platforms: ["mastodon"] is not a list, each one of x, threads',
			),
		},
	});
});

test('a list with min is required, with minItems in its schema; min 0 changes nothing', () => {
	const schema = (fields: Record<string, ReturnType<typeof field.list>>) =>
		JSON.parse(JSON.stringify(Type.Object(fields)));
	expect(schema({ airports: field.list(field.text(), { min: 1 }) })).toEqual({
		type: 'object',
		required: ['airports'],
		properties: {
			airports: {
				type: 'array',
				minItems: 1,
				'x-epicenter-field': 'list',
				items: { type: 'string' },
			},
		},
	});
	expect(schema({ tags: field.list(field.text(), { min: 0 }) })).toEqual(
		schema({ tags: field.list(field.text()) }),
	);
	expect(() => field.list(field.text(), { min: -1 })).toThrow(
		"field.list's min must be a whole number of at least 0, not -1",
	);
});

test('a list with min reads as missing when its line is absent, and refuses too few items', async () => {
	const trips = defineCollection({
		path: 'data/trips/{trip}.md',
		fields: { airports: field.list(field.text(), { min: 2 }) },
	});
	const context = createMemoryContext({ 'data/trips/a.md': '---\n---\n' });
	expect<unknown>(await inRun(context, () => trips.get({ trip: 'a' }))).toEqual(
		ActionError.Misfit({
			path: 'data/trips/a.md',
			problems: [{ line: 'airports is missing', kind: 'airports is missing' }],
			record: { path: 'data/trips/a.md', trip: 'a', body: '' },
		}),
	);
	await expect(
		inRun(context, () => trips.add({ trip: 'b', airports: ['SFO'] })),
	).resolves.toMatchObject({
		error: {
			message: expect.stringContaining(
				'data/trips/b.md: airports: ["SFO"] is not a list of text with at least 2 items',
			),
		},
	});
	await expect(
		inRun(context, () => trips.add({ trip: 'b' } as never)),
	).resolves.toMatchObject({
		error: {
			message: expect.stringContaining('data/trips/b.md: airports is missing'),
		},
	});
});

test("an action's call does not fill a list with min", async () => {
	let given: unknown;
	const save = defineAction({
		description: 'Save a route',
		input: {
			airports: field.list(field.text(), { min: 1 }),
			tags: field.list(field.text()),
		},
		run: (input) => {
			given = input;
			return Ok(null);
		},
	});
	await save({ airports: ['SFO', 'NRT'] });
	expect(given).toEqual({ airports: ['SFO', 'NRT'], tags: [] });
	await save({} as never);
	expect(given).toEqual({ tags: [] });
});
