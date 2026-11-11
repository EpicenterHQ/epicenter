/**
 * A UI's client asks serve to run an action and answers a Result: what it
 * returned, or which of serve's answers said why not. The client finds its app
 * from the UI's URL or accepts an explicit app when there is no UI.
 */
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { connect } from './client.ts';
import { defineAction, defineApp, defineCollection, field } from './index.ts';

const books = defineCollection({
	path: 'data/books/{title}.md',
	fields: { rating: field.integer({ optional: true }) },
});

const reading = defineApp({
	description: 'Books',
	collections: { books },
	actions: { ...books.actions() },
});

const sent: { url: string; input: unknown }[] = [];
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

/** Serve `chunks` as one response body, each chunk sent on its own, recording what was asked. */
function respond(chunks: string[]) {
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		urls.push(url);
		sent.push({ url, input: JSON.parse(String(init.body)) });
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
					controller.close();
				},
			}),
		);
	}) as typeof fetch;
}

/** Answer every call with `answer` as its one line. */
function answer(value: unknown) {
	respond([`${JSON.stringify({ answer: value })}\n`]);
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
	answer({ returned: [] });
	await connect<typeof reading>().list();
	expect(urls).toEqual(['/reading/list']);
});

test('connect infers the app from location with no document', async () => {
	Reflect.deleteProperty(globalThis, 'document');
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/reading/#/books/Dune.md' },
	});
	answer({ returned: [] });
	await connect<typeof reading>().list();
	expect(urls).toEqual(['/reading/list']);
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
	answer({ returned: [] });
	await connect<typeof reading>({ app: 'reading', url: 'https://studio/epi' }).list();
	expect(urls).toEqual(['https://studio/epi/reading/list']);
});

test("a call posts its input to the action's address and answers what the action returned", async () => {
	answer({ returned: { path: 'data/books/Dune.md' } });
	expect<unknown>(expectOk(await app.get({ path: 'data/books/Dune.md' }))).toEqual({
		path: 'data/books/Dune.md',
	});
	expect(sent).toEqual([
		{ url: '/reading/get', input: { path: 'data/books/Dune.md' } },
	]);
});

test('each value the action yields reaches onYield in order, however the lines arrive in chunks', async () => {
	const yielding = defineAction({
		description: 'Count',
		input: {},
		async *run() {
			yield 1;
			yield 2;
			return 'done';
		},
	});
	const counter = connect<{ actions: { count: typeof yielding } }>({
		app: 'counter',
	});
	respond(['{"yielded":1}\n{"yiel', 'ded":2}\n{"answer":', '{"returned":"done"}}\n']);
	const heard: number[] = [];
	expect(
		expectOk(await counter.count({}, { onYield: (n) => heard.push(n) })),
	).toBe('done');
	expect(heard).toEqual([1, 2]);
	expect(urls).toEqual(['/counter/count']);

	respond(['{"yielded":1}\n']);
	expect(expectErr(await counter.count())).toMatchObject({
		name: 'Unreachable',
		message: 'Epicenter stopped answering before the action finished',
	});
});

test('each way serve answers without a value is its own error', async () => {
	answer({
		threw: {
			message: 'data/books/Dune.md changed',
			thrown: {
				name: 'Changed',
				message: 'data/books/Dune.md changed',
				path: 'data/books/Dune.md',
				why: 'quote',
			},
		},
	});
	expect(
		expectErr(await app.edit({ path: 'data/books/Dune.md', old: 'a', new: 'b' })),
	).toMatchObject({ name: 'Changed', path: 'data/books/Dune.md', why: 'quote' });

	answer({
		threw: {
			message: 'There is no data/books/Dune.md',
			thrown: {
				name: 'Missing',
				message: 'There is no data/books/Dune.md',
				path: 'data/books/Dune.md',
			},
		},
	});
	expect(expectErr(await app.get({ path: 'data/books/Dune.md' }))).toMatchObject({
		name: 'Missing',
		path: 'data/books/Dune.md',
	});

	answer({ threw: { message: 'boom' } });
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Threw',
		message: 'boom',
	});

	answer({
		error: { name: 'InputError', message: 'path is required', next: 'Give a path' },
	});
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
