/**
 * A view's client asks serve to run an action and answers a Result: what it
 * returned, or which of serve's answers said why not. Wellcrafted's maps turn
 * those calls into TanStack options, and the view's one QueryClient refreshes
 * every read after any write. The client finds its app from the UI's URL or
 * accepts an explicit app when there is no UI.
 */
import { afterEach, expect, test } from 'bun:test';
import { MutationObserver, QueryObserver } from '@tanstack/query-core';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { connect, createQueryClient } from './client.ts';
import { defineApp, defineCollection, field } from './index.ts';

const books = defineCollection({
	path: 'books/{title}.md',
	fields: { rating: field.integer({ optional: true }) },
});

const reading = defineApp({
	description: 'Books',
	collections: { books },
	actions: { ...books.actions() },
});

const sent: { name: string; arguments: unknown }[] = [];
const urls: string[] = [];
const realFetch = globalThis.fetch;
const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const realLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
afterEach(() => {
	globalThis.fetch = realFetch;
	sent.length = 0;
	urls.length = 0;
	if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
	else Reflect.deleteProperty(globalThis, 'document');
	if (realLocation) Object.defineProperty(globalThis, 'location', realLocation);
	else Reflect.deleteProperty(globalThis, 'location');
});

/** Answer every call with `structuredContent`, recording what was asked. */
function answer(content: (name: string) => unknown) {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		urls.push(url);
		const { params } = JSON.parse(String(init.body));
		sent.push({ name: params.name, arguments: params.arguments });
		return Response.json({
			result: { structuredContent: content(params.name) },
		});
	}) as typeof fetch;
}

const app = connect<typeof reading>({ app: 'reading' });

test('connect infers the app from document baseURI before location', async () => {
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { baseURI: 'https://host/reading/#/books/Dune.md' },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/other/#/books/Dune.md' },
	});
	answer(() => ({ returned: [] }));
	await connect<typeof reading>().list();
	expect(sent[0]?.name).toBe('reading_list');
	expect(urls).toEqual(['/']);
});

test('connect infers the app from location with no document', async () => {
	Reflect.deleteProperty(globalThis, 'document');
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/reading/#/books/Dune.md' },
	});
	answer(() => ({ returned: [] }));
	await connect<typeof reading>().list();
	expect(sent[0]?.name).toBe('reading_list');
});

test('connect requires an app when the page has no first path segment', () => {
	Reflect.deleteProperty(globalThis, 'document');
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/#/reading/' },
	});
	expect(() => connect<typeof reading>()).toThrow(
		'UI served at /<app>/ or an explicit { app }',
	);
});

test('connect uses an explicit app without page globals', async () => {
	Reflect.deleteProperty(globalThis, 'document');
	Reflect.deleteProperty(globalThis, 'location');
	answer(() => ({ returned: [] }));
	await connect<typeof reading>({ app: 'reading', url: '/mcp' }).list();
	expect(sent[0]?.name).toBe('reading_list');
	expect(urls).toEqual(['/mcp']);
});

test('a call asks for its MCP tool and answers what the action returned', async () => {
	answer(() => ({ returned: { path: 'books/Dune.md' } }));
	expect<unknown>(expectOk(await app.get({ path: 'books/Dune.md' }))).toEqual({
		path: 'books/Dune.md',
	});
	expect(sent).toEqual([
		{ name: 'reading_get', arguments: { path: 'books/Dune.md' } },
	]);
});

test('each way serve answers without a value is its own error', async () => {
	answer(() => ({
		threw: {
			message: 'books/Dune.md changed',
			thrown: {
				name: 'Changed',
				message: 'books/Dune.md changed',
				path: 'books/Dune.md',
				why: 'quote',
			},
		},
	}));
	expect(
		expectErr(await app.edit({ path: 'books/Dune.md', old: 'a', new: 'b' })),
	).toMatchObject({ name: 'Changed', path: 'books/Dune.md', why: 'quote' });

	answer(() => ({
		threw: {
			message: 'There is no books/Dune.md',
			thrown: {
				name: 'Missing',
				message: 'There is no books/Dune.md',
				path: 'books/Dune.md',
			},
		},
	}));
	expect(expectErr(await app.get({ path: 'books/Dune.md' }))).toMatchObject({
		name: 'Missing',
		path: 'books/Dune.md',
	});

	answer(() => ({ threw: { message: 'boom' } }));
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Threw',
		message: 'boom',
	});

	answer(() => ({
		error: { name: 'InputError', message: 'path is required', next: 'Give a path' },
	}));
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Refused',
		message: 'path is required',
		next: 'Give a path',
	});

	globalThis.fetch = (async () =>
		new Response('', {
			status: 502,
			statusText: 'Bad Gateway',
		})) as unknown as typeof fetch;
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Unreachable',
		message: 'Epicenter answered 502 Bad Gateway',
	});
});

test('every write refreshes every read the page shows, before the write is done', async () => {
	let lists = 0;
	answer((name) => ({
		returned: name === 'reading_list' ? [{ list: ++lists }] : true,
	}));
	const bookReads = resultQueries(['reading'], { list: app.list });
	const bookWrites = resultMutations(['reading'], { delete: app.delete });
	const client = createQueryClient();
	const stop = new QueryObserver(client, bookReads.list()).subscribe(() => {});
	try {
		await client.query(bookReads.list());
		expect<unknown>(client.getQueryData(bookReads.list().queryKey)).toEqual([
			{ list: 1 },
		]);
		await new MutationObserver(client, bookWrites.delete).mutate({
			path: 'books/Dune.md',
		});
		expect<unknown>(client.getQueryData(bookReads.list().queryKey)).toEqual([
			{ list: 2 },
		]);
	} finally {
		stop();
		client.clear();
	}
});
