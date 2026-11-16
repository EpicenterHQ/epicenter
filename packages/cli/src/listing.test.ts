/**
 * App listing schemas
 *
 * A generic page reads a field's kind from the app listing alone, so a
 * `field.ref` prints as text carrying `x-epicenter-ref` with its target's path.
 *
 * Key behaviors:
 * - a reference's schema names its target's path, in a collection's fields
 *   and in an action's input, a list of them included
 */
import { expect, test } from 'bun:test';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineCollection,
	field,
} from '@epicenter/app';
import type { Runnable } from './home.ts';
import { oneAppListing } from './listing.ts';

test("a reference's schema names its target's path in the listing", () => {
	const shelves = defineCollection({
		path: 'data/shelves/{shelf}.md',
		fields: {},
	});
	const books = defineCollection({
		path: 'data/books/{book}.md',
		fields: { shelf: field.ref(shelves, { optional: true }) },
	});
	const shelve = defineAction({
		description: 'Shelve a book',
		input: { shelves: field.list(field.ref(shelves)) },
		run: (input) => input,
	});
	const app = defineApp({
		description: 'Books',
		collections: { shelves, books },
		actions: { shelve },
	});
	const located: Runnable = {
		entry: 'books',
		folder: '/tmp/books',
		realPath: '/tmp/books',
		codePath: '/tmp/books/code',
		ok: true,
		name: 'books',
		app,
		actions: { shelve },
		context: createMemoryContext(),
	};
	const listed = oneAppListing(located, true) as {
		collections: Record<string, { fields: { properties: object } }>;
		actions: { inputSchema: { properties: object } }[];
	};
	const ref = { 'x-epicenter-ref': { path: 'data/shelves/{shelf}.md' } };
	expect(listed.collections.books?.fields.properties).toEqual({
		shelf: { type: 'string', ...ref },
	});
	expect(listed.actions[0]?.inputSchema.properties).toEqual({
		shelves: {
			type: 'array',
			'x-epicenter-field': 'list',
			items: { type: 'string', ...ref },
		},
	});
});
