/** Ordinary calls use run admission, parse ordered events, and preserve action errors. */
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineAction } from './action.ts';
import { connect } from './client.ts';
import { ActionError } from './errors.ts';

const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(
	globalThis,
	'document',
);
const originalLocation = Object.getOwnPropertyDescriptor(
	globalThis,
	'location',
);
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalDocument)
		Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
	if (originalLocation)
		Object.defineProperty(globalThis, 'location', originalLocation);
	else Reflect.deleteProperty(globalThis, 'location');
});
const count = defineAction({
	description: 'Count',
	input: {},
	async *run() {
		yield 1;
		yield 2;
		return 'done';
	},
});
const app = connect<{ actions: { count: typeof count } }>({ app: 'counter' });
const line = (seq: number, fields: object) =>
	JSON.stringify({ seq, at: 'now', ...fields }) + '\n';
function respond(answer: unknown) {
	globalThis.fetch = (async () =>
		new Response(
			line(1, { type: 'finished', answer }),
		)) as unknown as typeof fetch;
}

test('ordinary call posts input to the run route and waits for async yield callbacks', async () => {
	const requests: { url: string; body: string }[] = [];
	const text =
		line(1, { type: 'accepted' }) +
		line(2, { type: 'yielded', value: 1 }) +
		line(3, { type: 'yielded', value: 2 }) +
		line(4, { type: 'finished', answer: { returned: 'done' } });
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({ url: String(url), body: String(init?.body) });
		const bytes = new TextEncoder().encode(text);
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes.slice(0, 19));
					controller.enqueue(bytes.slice(19));
					controller.close();
				},
			}),
		);
	}) as unknown as typeof fetch;
	const heard: number[] = [];
	expectOk(
		await app.count(
			{},
			{
				onYield: async (n) => {
					await Promise.resolve();
					heard.push(n);
				},
			},
		),
	);
	expect(heard).toEqual([1, 2]);
	expect(requests).toHaveLength(1);
	expect(requests[0]?.url).toMatch(/^\/.runs\/counter\/count\/[\da-f-]+$/);
	expect(requests[0]?.body).toBe('{}');
});

test('all shared error variants cross a finished answer unchanged', async () => {
	for (const result of [
		ActionError.Changed({ path: 'x', why: 'quote' }),
		ActionError.Missing({ path: 'x' }),
		ActionError.Threw({ message: 'bad' }),
		ActionError.Refused({ message: 'no' }),
		ActionError.Unreachable({ message: 'unreachable' }),
		ActionError.Stopped({ message: 'stopped' }),
	]) {
		const thrown = { ...result.error, extra: 'retained' };
		respond({ threw: { message: thrown.message, thrown } });
		expect(expectErr(await app.count())).toEqual(thrown);
	}
	respond({ error: { message: 'refused', next: 'retry' } });
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Refused',
		message: 'refused',
		next: 'retry',
	});
	respond({
		threw: { message: 'bad', thrown: { name: 'Custom', message: 'bad' } },
	});
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Threw',
		thrown: { name: 'Custom' },
	});
	for (const malformed of [
		null,
		{},
		{ returned: 1, error: { message: 'bad' } },
		{ threw: {} },
		{ threw: { message: 'bad', thrown: {} } },
		{ error: {} },
		{ error: { message: 'bad', next: 42 } },
	]) {
		respond(malformed);
		expect(expectErr(await app.count())).toMatchObject({
			name: 'Unreachable',
			run: { app: 'counter', action: 'count' },
		});
	}
	respond({});
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Unreachable',
		run: { app: 'counter', action: 'count' },
	});
});

test('invalid frames fail with identity, and an onYield throw does not cancel', async () => {
	globalThis.fetch = (async () =>
		new Response('not-json\n')) as unknown as typeof fetch;
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Unreachable',
		run: { app: 'counter', action: 'count' },
	});
	const methods: string[] = [];
	globalThis.fetch = (async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		methods.push(init?.method ?? 'GET');
		return new Response(
			line(1, { type: 'yielded', value: 1 }) +
				line(2, { type: 'finished', answer: { returned: 'done' } }),
		);
	}) as unknown as typeof fetch;
	const failure = new Error('callback');
	await expect(
		app.count(
			{},
			{
				onYield: () => {
					throw failure;
				},
			},
		),
	).rejects.toBe(failure);
	expect(methods).toEqual(['POST']);
});

test('refusal does not GET; uncertain admission observes the same id', async () => {
	let urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return Response.json(
			{ error: { message: 'no' }, admitted: false },
			{ status: 503 },
		);
	}) as unknown as typeof fetch;
	expect(expectErr(await app.count()).name).toBe('Refused');
	expect(urls).toHaveLength(1);
	urls = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response('', { status: 400 });
	}) as unknown as typeof fetch;
	expect(expectErr(await app.count()).name).toBe('Refused');
	expect(urls).toHaveLength(1);
	urls = [];
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		urls.push(String(url));
		if (init?.method === 'POST') throw new Error('lost');
		return new Response(
			line(1, { type: 'finished', answer: { returned: 'done' } }),
		);
	}) as unknown as typeof fetch;
	expectOk(await app.count());
	expect(urls).toHaveLength(2);
	expect(urls[1]).toBe(`${urls[0]}/events?after=0`);
});

test('signal on an ordinary call is refused before a request', async () => {
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		return new Response();
	}) as unknown as typeof fetch;
	const options = { signal: new AbortController().signal };
	// @ts-expect-error signal is not an ordinary call option.
	expect(expectErr(await app.count({}, options)).name).toBe('Refused');
	expect(requests).toBe(0);
});

test('connect infers the app from document, location, or explicit options', async () => {
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response(
			line(1, { type: 'finished', answer: { returned: 'done' } }),
		);
	}) as unknown as typeof fetch;
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { baseURI: 'https://host/reading/' },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/other/' },
	});
	await connect<{ actions: { count: typeof count } }>().count();
	Reflect.deleteProperty(globalThis, 'document');
	await connect<{ actions: { count: typeof count } }>().count();
	await connect<{ actions: { count: typeof count } }>({
		app: 'explicit',
		url: 'https://host/base',
	}).count();
	expect(urls[0]).toMatch(/^\/.runs\/reading\/count\//);
	expect(urls[1]).toMatch(/^\/.runs\/other\/count\//);
	expect(urls[2]).toMatch(/^https:\/\/host\/base\/.runs\/explicit\/count\//);
});

test('connect requires an app when the page has no first path segment', () => {
	Reflect.deleteProperty(globalThis, 'document');
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: { href: 'https://host/#/reading/' },
	});
	expect(() => connect()).toThrow(
		'UI served at /<app>/ or an explicit { app }',
	);
});

test('unmarked and malformed shared errors remain in the Threw payload', async () => {
	for (const thrown of [
		{ name: 'Missing', message: 'custom', recordId: 1 },
		{
			namespace: 'epicenter/action-error',
			name: 'Changed',
			message: 'bad',
			path: 'x',
			why: 'other',
		},
	]) {
		respond({ threw: { message: thrown.message, thrown } });
		expect(expectErr(await app.count())).toMatchObject({
			name: 'Threw',
			thrown,
		});
	}
});

test('a terminal answer does not wait for EOF or failing stream cancellation', async () => {
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode(
							line(1, { type: 'finished', answer: { returned: 'done' } }),
						),
					);
				},
				cancel() {
					return Promise.reject(new Error('cleanup failed'));
				},
			}),
		)) as unknown as typeof fetch;
	expect(expectOk(await app.count())).toBe('done');
});
