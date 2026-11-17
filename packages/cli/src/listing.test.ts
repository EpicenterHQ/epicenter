/**
 * App listing schemas
 *
 * A generic page reads a field's kind from the app listing alone, so a
 * `field.ref` prints as an id carrying `x-epicenter-ref` with its target key.
 *
 * Key behaviors:
 * - a reference's schema names its target key, in a data key's fields and in
 *   an action's input, a list of them included
 */
import { expect, test } from 'bun:test';
import {
	createMemoryContext,
	defineAction,
	defineApp,
	defineData,
	field,
	Ok,
} from '@epicenter/app';
import type { Runnable } from './home.ts';
import { oneAppListing } from './listing.ts';

test("a reference's schema names its target key in the listing", () => {
	const data = defineData({
		shelves: { fields: {} },
		books: { fields: { shelf: field.ref('shelves', { optional: true }) } },
	});
	const shelve = defineAction({
		description: 'Shelve a book',
		input: { shelves: field.list(field.ref('shelves')) },
		run: (input) => Ok(input),
	});
	const app = defineApp({ description: 'Books', data, actions: { shelve } });
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
		data: Record<string, { fields: { properties: object } }>;
		actions: { inputSchema: { properties: object } }[];
	};
	const ref = {
		type: 'string',
		format: 'epicenter-id',
		'x-epicenter-ref': { key: 'shelves' },
	};
	expect(listed.data.books?.fields.properties).toEqual({ shelf: ref });
	expect(listed.actions[0]?.inputSchema.properties).toEqual({
		shelves: { type: 'array', 'x-epicenter-field': 'list', items: ref },
	});
});
