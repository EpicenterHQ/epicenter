/**
 * A UI's client asks serve to run an action and answers a Result: what it
 * returned, or which of serve's answers said why not. The client finds its app
 * from the UI's URL or accepts an explicit app when there is no UI.
 */
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { connect } from './client.js';
import { ActionError } from './errors.js';
import { defineAction, defineApp, defineCollection, field } from './index.js';

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

const count = defineAction({
	description: 'Count',
	input: {},
	async *run() {
		yield 1;
		yield 2;
		return 'done';
	},
});
const counter = connect<{ actions: { count: typeof count } }>({
	app: 'counter',
});

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
	await connect<typeof reading>({
		app: 'reading',
		url: 'https://studio/epi',
	}).list();
	expect(urls).toEqual(['https://studio/epi/reading/list']);
});

test("a call posts its input to the action's address and answers what the action returned", async () => {
	answer({ returned: { path: 'data/books/Dune.md' } });
	expect<unknown>(
		expectOk(await app.get({ path: 'data/books/Dune.md' })),
	).toEqual({
		path: 'data/books/Dune.md',
	});
	expect(sent).toEqual([
		{ url: '/reading/get', input: { path: 'data/books/Dune.md' } },
	]);
});

test('each value the action yields reaches onYield in order, however the lines arrive in chunks', async () => {
	respond([
		'{"yielded":1}\n{"yiel',
		'ded":2}\n{"answer":',
		'{"returned":"done"}}\n',
	]);
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

test('aborting while awaiting a yield callback stops reading and resolves as Stopped', async () => {
	// Like fetch, the body errors once the request's signal aborts.
	globalThis.fetch = (async (_url: string, init: RequestInit) =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"yielded":1}\n'));
					init.signal?.addEventListener('abort', () =>
						controller.error(new DOMException('aborted', 'AbortError')),
					);
				},
			}),
		)) as typeof fetch;
	const stop = new AbortController();
	const heard: number[] = [];
	const stopped = await counter.count(
		{},
		{
			onYield: async (n) => {
				heard.push(n);
				await Promise.resolve();
				stop.abort();
			},
			signal: stop.signal,
		},
	);
	expect(expectErr(stopped)).toMatchObject({ name: 'Stopped' });
	expect(heard).toEqual([1]);
});

test('each way serve answers without a value is its own error', async () => {
	answer({
		threw: {
			message: 'data/books/Dune.md changed',
			thrown: {
				namespace: 'epicenter/action-error',
				name: 'Changed',
				message: 'data/books/Dune.md changed',
				path: 'data/books/Dune.md',
				why: 'quote',
			},
		},
	});
	expect(
		expectErr(
			await app.edit({ path: 'data/books/Dune.md', old: 'a', new: 'b' }),
		),
	).toMatchObject({
		name: 'Changed',
		path: 'data/books/Dune.md',
		why: 'quote',
	});

	answer({
		threw: {
			message: 'There is no data/books/Dune.md',
			thrown: {
				namespace: 'epicenter/action-error',
				name: 'Missing',
				message: 'There is no data/books/Dune.md',
				path: 'data/books/Dune.md',
			},
		},
	});
	expect(
		expectErr(await app.get({ path: 'data/books/Dune.md' })),
	).toMatchObject({
		name: 'Missing',
		path: 'data/books/Dune.md',
	});

	answer({ threw: { message: 'boom' } });
	expect(expectErr(await app.list())).toMatchObject({
		name: 'Threw',
		message: 'boom',
	});

	answer({
		error: {
			name: 'InputError',
			message: 'path is required',
			next: 'Give a path',
		},
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

for (const asynchronous of [false, true]) {
	for (const abort of [false, true]) {
		test(`${asynchronous ? 'async' : 'sync'} callback failure rejects unchanged and cancels the response${abort ? ', even after aborting' : ''}`, async () => {
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"yielded":1}\n'));
				},
				cancel() {
					cancelled = true;
					throw new Error('cleanup failed');
				},
			});
			globalThis.fetch = (async () =>
				new Response(body)) as unknown as typeof fetch;
			const bug = new Error('callback failed');
			const stop = new AbortController();
			const fail = () => {
				if (abort) stop.abort();
				throw bug;
			};
			await expect(
				counter.count(
					{},
					{
						onYield: asynchronous ? async () => fail() : fail,
						signal: stop.signal,
					},
				),
			).rejects.toBe(bug);
			expect(cancelled).toBe(true);
			expect(body.locked).toBe(false);
		});
	}
}

test('async callbacks finish in order before the next yield is delivered', async () => {
	respond(['{"yielded":1}\n{"yielded":2}\n{"answer":{"returned":"done"}}\n']);
	const heard: string[] = [];
	expect(
		expectOk(
			await counter.count(
				{},
				{
					onYield: async (value) => {
						heard.push(`start ${value}`);
						await Promise.resolve();
						heard.push(`end ${value}`);
					},
				},
			),
		),
	).toBe('done');
	expect(heard).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
});

for (const status of [200, 502]) {
	test(`a ${status} response settles without waiting for EOF or cancellation cleanup`, async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						'{"answer":{"returned":"done"}}\n{"answer":{"returned":"second"}}\n',
					),
				);
			},
			cancel() {
				cancelled = true;
				return new Promise<void>(() => {});
			},
		});
		globalThis.fetch = (async () =>
			new Response(body, { status })) as unknown as typeof fetch;
		const result = await counter.count();
		if (status === 200) expect(expectOk(result)).toBe('done');
		else expect(expectErr(result).name).toBe('Unreachable');
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
	});
}

test('a cancellation failure cannot replace a received answer', async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode('{"answer":{"returned":"done"}}\n'),
			);
		},
		cancel() {
			throw new Error('cleanup failed');
		},
	});
	globalThis.fetch = (async () =>
		new Response(body)) as unknown as typeof fetch;
	expect(expectOk(await counter.count())).toBe('done');
	expect(body.locked).toBe(false);
});

test('unmarked and malformed shared errors stay inside Threw with their fields intact', async () => {
	for (const thrown of [
		{ name: 'Missing', message: 'custom', recordId: 1 },
		{ name: 'Missing', message: 'custom', path: 1 },
		{ name: 'Changed', message: 'custom', path: 'data/a.md' },
		{ name: 'Changed', message: 'custom', path: 'data/a.md', why: 'other' },
		{ name: 'Changed', message: 'custom', path: 'data/a.md', why: 'toString' },
		{ name: 'Stopped', message: 'custom', reason: 'an app-specific error' },
		{
			namespace: 'epicenter/action-error',
			name: 'Changed',
			message: 'bad',
			path: 'data/a.md',
			why: 'other',
		},
	]) {
		answer({ threw: { message: thrown.message, thrown } });
		expect(expectErr(await app.list())).toMatchObject({
			name: 'Threw',
			message: thrown.message,
			thrown,
		});
	}
	for (const why of ['quote', 'empty', 'kept'] as const) {
		const thrown = {
			namespace: 'epicenter/action-error' as const,
			name: 'Changed' as const,
			message: 'custom message',
			path: 'data/a.md',
			why,
			extra: 1,
		};
		answer({ threw: { message: thrown.message, thrown } });
		expect(expectErr(await app.list())).toEqual(thrown);
	}
});

test('all shared error variants cross unchanged, including nested failures and Threw payloads', async () => {
	const custom = {
		name: 'ProposalChanged',
		message: 'Review again',
		proposal: 'p',
	};
	for (const result of [
		ActionError.Changed({ path: 'data/a.md', why: 'quote' }),
		ActionError.Missing({ path: 'data/a.md' }),
		ActionError.Threw({ message: custom.message, thrown: custom }),
		ActionError.Refused({ message: 'Dependency declined', next: 'Inspect it' }),
		ActionError.Unreachable({ message: 'The model did not answer' }),
		ActionError.Stopped({ message: 'The dependency stopped' }),
	]) {
		const thrown = { ...result.error, extra: 'retained' };
		answer({ threw: { message: thrown.message, thrown } });
		expect(expectErr(await app.list())).toEqual(thrown);
	}
	answer({ threw: { message: custom.message, thrown: custom } });
	const error = expectErr(await app.list());
	expect(error).toMatchObject({ name: 'Threw', thrown: custom });
	if (error.name === 'Threw')
		expect(error.thrown?.name).toBe('ProposalChanged');
});

test('malformed protocol frames and answer metadata resolve as Unreachable', async () => {
	for (const frame of [
		null,
		42,
		[],
		{},
		{ yielded: 1, answer: { returned: 2 } },
		{ answer: null },
		{ answer: 42 },
		{ answer: [] },
		{ answer: {} },
		{ answer: { returned: 1, threw: { message: 'ambiguous' } } },
		{ answer: { threw: { message: 42 } } },
		{ answer: { threw: { message: 'bad', thrown: { name: 'Missing' } } } },
		{ answer: { error: { message: 'bad', next: 42 } } },
	]) {
		respond([`${JSON.stringify(frame)}\n`]);
		expect(expectErr(await app.list()).name).toBe('Unreachable');
	}
	respond(['not JSON\n']);
	expect(expectErr(await app.list()).name).toBe('Unreachable');
});

test('request and response read failures resolve as Unreachable, while invalid local input rejects', async () => {
	globalThis.fetch = (async () => {
		throw new TypeError('offline');
	}) as unknown as typeof fetch;
	expect(expectErr(await app.list()).name).toBe('Unreachable');
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new TypeError('connection lost'));
				},
			}),
		)) as unknown as typeof fetch;
	expect(expectErr(await app.list()).name).toBe('Unreachable');
	await expect(
		app.get({
			path: 'a',
			toJSON() {
				throw new Error('invalid input');
			},
		} as { path: string }),
	).rejects.toThrow('invalid input');
});
