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
	defineAction,
	defineApp,
	defineData,
	type Folder,
	field,
	Ok,
} from '../index.ts';
import type { Runnable } from './home.ts';
import { homeListing, oneAppListing } from './listing.ts';

test("a reference's schema names its target key in the listing", () => {
	const data = defineData({} as Folder, {
		shelves: { fields: {} },
		books: { fields: { shelf: field.ref('shelves', { optional: true }) } },
	});
	const shelve = defineAction({
		description: 'Shelve a book',
		input: { shelves: field.list(field.ref('shelves')) },
		run: (input) => Ok(input),
	});
	const app = defineApp(() => ({
		description: 'Books',
		data,
		actions: { shelve },
	}))({ folder: {} as Folder });
	const located: Runnable = {
		entry: 'books',
		folder: '/tmp/books',
		realPath: '/tmp/books',
		codePath: '/tmp/books/code',
		ok: true,
		name: 'books',
		app,
		actions: { shelve },
	};
	const listed = oneAppListing(located, true) as {
		data: Record<string, { fields: { properties: object } }>;
		actions: { inputSchema: { properties: object } }[];
	};
	const ref = {
		type: 'string',
		'x-epicenter-ref': { key: 'shelves' },
	};
	expect(listed.data.books?.fields.properties).toEqual({ shelf: ref });
	expect(listed.actions[0]?.inputSchema.properties).toEqual({
		shelves: { type: 'array', 'x-epicenter-field': 'list', items: ref },
	});
});

test('an app that answers web requests says so, and lists none of its routes', () => {
	const app = defineApp(() => ({
		description: 'Mail',
		actions: {},
		fetch: () => new Response('ok'),
	}))({ folder: {} as Folder });
	const located: Runnable = {
		entry: 'mail',
		folder: '/tmp/mail',
		realPath: '/tmp/mail',
		codePath: '/tmp/mail/code',
		ok: true,
		name: 'mail',
		app,
		actions: {},
	};
	expect(oneAppListing(located, true)).toMatchObject({
		fetch: true,
		actions: [],
	});
	expect(oneAppListing(located, false)).toStartWith(
		'mail  Mail (answers web requests)\n',
	);
	const found = { epicenter: '/tmp/home', apps: [located], problems: [] };
	expect(homeListing(found, [], false)).toContain(
		'mail  Mail (answers web requests)',
	);
	const plain = { ...located, app: { description: 'Mail', actions: {} } };
	expect(oneAppListing(plain, true)).not.toHaveProperty('fetch');
});
