/** A page's call posts its input, hears updates in order, and reads the answer line. */
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineAction, type Update } from './action.ts';
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
	async run(_input, update: Update<1 | 2>) {
		update(1);
		update(2);
		return Ok('done');
	},
});
const app = connect<{
	actions: { count: typeof count; deep: { count: typeof count } };
}>({
	app: 'counter',
});
const line = (fields: object) => `${JSON.stringify(fields)}\n`;
const answer = (data: unknown) => line({ answer: { data, error: null } });
const failed = (error: object) => line({ answer: { data: null, error } });
function respond(text: string, init?: ResponseInit) {
	globalThis.fetch = (async () =>
		new Response(text, init)) as unknown as typeof fetch;
}

test('a call posts its input to the action and hears updates in order across chunks', async () => {
	const requests: { url: string; method?: string; body: string }[] = [];
	const text = line({ update: 1 }) + line({ update: 2 }) + answer('done');
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({
			url: String(url),
			method: init?.method,
			body: String(init?.body),
		});
		const bytes = new TextEncoder().encode(text);
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(bytes.slice(0, 7));
					controller.enqueue(bytes.slice(7));
					controller.close();
				},
			}),
		);
	}) as unknown as typeof fetch;
	const heard: number[] = [];
	expect(
		expectOk(await app.count({}, { onUpdate: (n) => heard.push(n) })),
	).toBe('done');
	expect(heard).toEqual([1, 2]);
	expect(requests).toEqual([
		{ url: '/counter/count', method: 'POST', body: '{}' },
	]);
	expectOk(await app.deep.count());
	expect(requests[1]?.url).toBe('/counter/deep.count');
});

test('a listener that throws or rejects is reported and does not end the call', async () => {
	const reported: unknown[] = [];
	const page = globalThis as { reportError?: (cause: unknown) => void };
	const original = page.reportError;
	page.reportError = (cause) => reported.push(cause);
	try {
		respond(line({ update: 1 }) + line({ update: 2 }) + answer('done'));
		const broke = new Error('callback');
		const result = await app.count(
			{},
			{
				onUpdate: (n) => {
					if (n === 1) throw broke;
					return Promise.reject(broke);
				},
			},
		);
		expect(expectOk(result)).toBe('done');
		await Promise.resolve();
		expect(reported).toEqual([broke, broke]);
	} finally {
		page.reportError = original;
	}
});

test('each kind of failure in an answer becomes its error', async () => {
	for (const result of [
		ActionError.Changed({ path: 'x', why: 'quote' }),
		ActionError.Missing({ path: 'x' }),
		ActionError.Stopped({ message: 'stopped' }),
	]) {
		const reason = { ...result.error, extra: 'retained' };
		respond(failed({ kind: 'returned', reason }));
		expect(expectErr(await app.count())).toEqual(reason);
	}
	respond(
		failed({ kind: 'returned', reason: { name: 'NoRoute', message: 'no' } }),
	);
	expect(expectErr(await app.count())).toMatchObject({
		name: 'NoRoute',
		message: 'no',
	});
	respond(
		failed({
			kind: 'fault',
			message: 'bad',
			thrown: { name: 'Custom', message: 'bad' },
		}),
	);
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Threw',
		message: 'bad',
		thrown: { name: 'Custom' },
	});
	respond(
		failed({
			kind: 'refused',
			reason: { name: 'Usage', message: 'refused', next: 'retry' },
		}),
	);
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Refused',
		message: 'refused',
		next: 'retry',
	});
});

test('a refusal before the action runs arrives as the body of an HTTP error', async () => {
	respond(
		JSON.stringify({
			data: null,
			error: {
				kind: 'refused',
				reason: { name: 'Usage', message: 'no such action' },
			},
		}),
		{ status: 404 },
	);
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Refused',
		message: 'no such action',
	});
	respond('', { status: 503, statusText: 'Service Unavailable' });
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Refused',
		message: 'Epicenter answered 503 Service Unavailable',
	});
});

test('an answer that is not one is Unreachable, and so is a stream cut off before it', async () => {
	for (const text of [
		'not-json\n',
		line([1]),
		line({ neither: true }),
		line({ answer: null }),
		line({ answer: {} }),
		line({ answer: { data: 1, error: { kind: 'fault', message: 'bad' } } }),
		failed({ kind: 'fault' }),
		failed({ kind: 'fault', message: 'bad', thrown: {} }),
		failed({ kind: 'returned', reason: {} }),
		failed({
			kind: 'refused',
			reason: { name: 'Usage', message: 'bad', next: 42 },
		}),
		failed({ kind: 'other' }),
	]) {
		respond(text);
		expect(expectErr(await app.count())).toMatchObject({
			name: 'Unreachable',
			message: 'Epicenter sent an invalid answer',
		});
	}
	for (const text of ['', line({ update: 1 }), answer('done').slice(0, -3)]) {
		respond(text);
		const error = expectErr(await app.count());
		expect(error.name).toBe('Unreachable');
		expect(error.message).toStartWith('The connection ended before the answer');
	}
});

test('a call that never reaches Epicenter says the action did not start', async () => {
	globalThis.fetch = (async () => {
		throw new Error('offline');
	}) as unknown as typeof fetch;
	expect(expectErr(await app.count())).toMatchObject({
		name: 'Unreachable',
		message: 'Epicenter could not be reached; the action did not start',
	});
});

test('connect infers the app from document, location, or explicit options', async () => {
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response(answer('done'));
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
	expect(urls).toEqual([
		'/reading/count',
		'/other/count',
		'https://host/base/explicit/count',
	]);
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

test('the answer does not wait for the stream to end or for its cancellation', async () => {
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(answer('done')));
				},
				cancel() {
					return Promise.reject(new Error('cleanup failed'));
				},
			}),
		)) as unknown as typeof fetch;
	expect(expectOk(await app.count())).toBe('done');
});
