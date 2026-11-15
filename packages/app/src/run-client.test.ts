/**
 * Browser-only run behavior: cancellation before admission, observation abort,
 * top-level action names, and file schema constraints without a running host.
 */
import { afterEach, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineAction } from './action.ts';
import { connect, runs } from './client.ts';
import { field, MAX_FILE_BYTES } from './field.ts';

const originalFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (storageDescriptor)
		Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
	else Reflect.deleteProperty(globalThis, 'localStorage');
});

function journal() {
	const entries = new Map<string, string>();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			get length() {
				return entries.size;
			},
			key: (index: number) => [...entries.keys()][index] ?? null,
			removeItem: (key: string) => entries.delete(key),
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
		},
	});
	return entries;
}

const upload = defineAction({
	description: 'Upload',
	input: { file: field.file() },
	run: () => null,
});
const empty = defineAction({
	description: 'Empty',
	input: {},
	run: () => null,
});
const app = connect<{
	actions: {
		upload: typeof upload;
		start: typeof empty;
		daily: { start: typeof empty; attach: typeof empty; pending: typeof empty };
		practice: { start: typeof empty };
	};
}>({ app: 'files' });

test('pending runs saved by the installed client remain reachable', () => {
	const saved = journal();
	const pending = {
		id: 'existing-upload-run',
		app: 'files',
		action: 'upload',
		startedAt: new Date().toISOString(),
		files: [{ field: 'file', name: 'note.txt', type: 'text/plain', size: 5 }],
	};
	saved.set('epicenter.runs.prototype.v1', JSON.stringify([pending]));
	expect(runs.pending(app.upload)).toEqual([pending]);
	expect(runs.attach(app.upload, pending.id).id).toBe(pending.id);
});

test('cancelling before admission sends no request and clears the journal', async () => {
	journal();
	let sent = 0;
	globalThis.fetch = (async () => {
		sent++;
		return new Response();
	}) as unknown as typeof fetch;
	const run = runs.start(app.upload, { file: new Blob(['hello']) });
	expectOk(await run.cancel());
	expect(expectErr(await run.result()).name).toBe('Stopped');
	expect(runs.pending(app.upload)).toEqual([]);
	expect(sent).toBe(0);
});

test('aborting result observation sends no cancellation request', async () => {
	journal();
	let sent = 0;
	globalThis.fetch = (async () => {
		sent++;
		return new Response();
	}) as unknown as typeof fetch;
	const stop = new AbortController();
	stop.abort();
	const run = runs.attach(app.upload, 'unknown-run-identifier');
	expect(
		expectErr(await run.result({ signal: stop.signal })).message,
	).toContain('Stopped waiting');
	expect(sent).toBe(0);
});

test('run controls preserve ordinary action names at every depth', async () => {
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response(
			'{"seq":1,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as typeof fetch;
	expectOk(await app.start());
	expectOk(await app.daily.start());
	expectOk(await app.practice.start());
	expectOk(await app.daily.attach());
	expectOk(await app.daily.pending());
	expect(urls.map((url) => url.replace(/[a-f0-9-]{36}$/, 'ID'))).toEqual(
		[
			'/\.runs/files/start/ID',
			'/\.runs/files/daily.start/ID',
			'/\.runs/files/practice.start/ID',
			'/\.runs/files/daily.attach/ID',
			'/\.runs/files/daily.pending/ID',
		].map((url) => url.replace('\\.', '.')),
	);
	journal();
	const hosted = runs.start(app.upload, { file: new Blob(['hello']) });
	expect(hosted).toHaveProperty('events');
	expectOk(await hosted.cancel());
});

test('file declarations validate MIME types, bounds, and positional use', () => {
	for (const maxBytes of [0, -1, 1.5, MAX_FILE_BYTES + 1])
		expect(() => field.file({ maxBytes })).toThrow('maxBytes');
	for (const accept of [['audio'], ['*/*'], ['text/plain; charset=utf-8']])
		expect(() => field.file({ accept })).toThrow('MIME');
	expect(() =>
		field.file({ accept: ['audio/*', 'text/plain'], maxBytes: 1 }),
	).not.toThrow();
	expect(() =>
		defineAction({
			description: 'Bad',
			input: { file: field.file() },
			positional: ['file'],
			run: () => null,
		}),
	).toThrow('as a positional');
});

for (const schema of [
	Type.Array(field.file()),
	Type.Object({ file: field.file() }),
	Type.Union([Type.String(), field.file()]),
]) {
	test(`nested file inputs are refused: ${JSON.stringify(schema)}`, () => {
		expect(() =>
			defineAction({
				description: 'Nested',
				input: { nested: schema },
				run: () => null,
			}),
		).toThrow('top-level');
	});
}

test('legacy receipt import skips malformed entries and is idempotent', () => {
	const saved = journal();
	const entry = (id: string) => ({
		id,
		app: 'files',
		action: 'upload',
		startedAt: new Date().toISOString(),
		files: [],
	});
	saved.set(
		'epicenter.runs.prototype.v1',
		JSON.stringify([entry('one'), null, entry('two')]),
	);
	saved.set('epicenter.run:broken', '{');
	expect(
		runs
			.pending(app.upload)
			.map((item) => item.id)
			.sort(),
	).toEqual(['one', 'two']);
	expect(
		runs
			.pending(app.upload)
			.map((item) => item.id)
			.sort(),
	).toEqual(['one', 'two']);
	expect(saved.has('epicenter.runs.prototype.v1')).toBe(false);
});

test('concurrent receipts persist and old receipts are pruned', async () => {
	const saved = journal();
	saved.set(
		'epicenter.run:old',
		JSON.stringify({
			id: 'old',
			app: 'files',
			action: 'upload',
			startedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
			files: [],
		}),
	);
	const active = Array.from({ length: 20 }, () =>
		runs.start(app.upload, { file: new Blob(['x']) }),
	);
	expect(active.every((run) => run.isRemembered())).toBe(true);
	expect(runs.pending(app.upload)).toHaveLength(20);
	expect(saved.has('epicenter.run:old')).toBe(false);
	await Promise.all(active.map((run) => run.cancel()));
});

test('unavailable storage falls back to memory while still sending', async () => {
	for (const mode of ['undefined', 'getter', 'write'] as const) {
		const entries = journal();
		if (mode === 'undefined')
			Object.defineProperty(globalThis, 'localStorage', {
				configurable: true,
				value: undefined,
			});
		if (mode === 'getter')
			Object.defineProperty(globalThis, 'localStorage', {
				configurable: true,
				get() {
					throw new Error('denied');
				},
			});
		if (mode === 'write')
			globalThis.localStorage.setItem = () => {
				throw new Error('full');
			};
		let count = 0;
		globalThis.fetch = (async () => {
			count++;
			return new Response(
				'{"seq":1,"at":"now","type":"finished","answer":{"returned":null}}\n',
			);
		}) as unknown as typeof fetch;
		const run = runs.start(app.start, {});
		expect(run.isRemembered()).toBe(false);
		expect(runs.pending(app.start).some((entry) => entry.id === run.id)).toBe(
			true,
		);
		expectOk(await run.result());
		expect(count).toBe(1);
		void entries;
	}
});

test('unknown run and unconfirmed cancel retain receipt and identity', async () => {
	journal();
	globalThis.fetch = (async () =>
		new Response('', { status: 404 })) as unknown as typeof fetch;
	const run = runs.start(app.start, {});
	// Let admission send before cancellation.
	await Promise.resolve();
	expect(expectErr(await run.result())).toMatchObject({ name: 'Refused' });
	// A separately attached missing id keeps an existing receipt.
	const pending = {
		id: 'missing-run-identifier',
		app: 'files',
		action: 'start',
		startedAt: new Date().toISOString(),
		files: [],
	};
	globalThis.localStorage.setItem(
		`epicenter.run:${pending.id}`,
		JSON.stringify(pending),
	);
	const attached = runs.attach(app.start, pending.id);
	expect(expectErr(await attached.result())).toMatchObject({
		name: 'Unreachable',
		run: { id: pending.id },
	});
	expect(expectErr(await attached.cancel())).toMatchObject({
		name: 'Unreachable',
		run: { id: pending.id },
	});
	expect(attached.isRemembered()).toBe(true);
});

test('ordinary calls leave receipts untouched and report identity after uncertain admission', async () => {
	const saved = journal();
	let posts = 0,
		gets = 0;
	globalThis.fetch = (async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		if (init?.method === 'POST') {
			posts++;
			throw new Error('lost');
		}
		gets++;
		return new Response('', { status: 404 });
	}) as unknown as typeof fetch;
	const answers = await Promise.all(
		Array.from({ length: 100 }, () => app.start()),
	);
	expect(
		answers.every(
			(answer) =>
				answer.error?.name === 'Unreachable' &&
				answer.error.run?.action === 'start',
		),
	).toBe(true);
	expect(posts).toBe(100);
	expect(gets).toBe(100);
	expect(saved.size).toBe(0);
	const run = runs.start(app.start, {});
	expect(run.isRemembered()).toBe(true);
	await run.cancel();
});

test('a terminal cursor ends without duplicate and caches its answer', async () => {
	journal();
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		return new Response(
			'{"seq":4,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as unknown as typeof fetch;
	const run = runs.attach(app.start, 'terminal-run-identifier');
	const frames = [];
	for await (const event of run.events({ after: 4 })) frames.push(event);
	expect(frames).toEqual([]);
	expectOk(await run.result());
	expect(requests).toBe(1);
});

test('replaying below a cached terminal retains the cached result', async () => {
	journal();
	let requests = 0;
	globalThis.fetch = (async (url: string | URL | Request) => {
		requests++;
		if (String(url).endsWith('after=4'))
			return new Response(
				'{"seq":4,"at":"now","type":"finished","answer":{"returned":null}}\n',
			);
		return new Response(
			'{"seq":1,"at":"now","type":"accepted"}\n{"seq":2,"at":"now","type":"started"}\n{"seq":3,"at":"now","type":"yielded","value":1}\n{"seq":4,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as unknown as typeof fetch;
	const run = runs.attach(app.start, 'terminal-replay-identifier');
	for await (const _event of run.events({ after: 4 })) {
		/* terminal was already seen */
	}
	const replay = [];
	for await (const event of run.events()) replay.push(event.type);
	expect(replay).toEqual(['accepted', 'started', 'yielded', 'finished']);
	expectOk(await run.result());
	expect(requests).toBe(2);
});

test('multiple observers share one reader and replay the same ordered frames', async () => {
	journal();
	let requests = 0;
	let deliver!: (bytes: Uint8Array) => void;
	globalThis.fetch = (async () => {
		requests++;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					deliver = (bytes) => {
						controller.enqueue(bytes);
						controller.close();
					};
				},
			}),
		);
	}) as unknown as typeof fetch;
	const run = runs.start(app.start, {});
	const collect = async () => {
		const events = [];
		for await (const event of run.events()) events.push(event);
		return events;
	};
	const first = collect();
	const second = collect();
	await Promise.resolve();
	await Promise.resolve();
	deliver(
		new TextEncoder().encode(
			'{"seq":1,"at":"now","type":"accepted"}\n{"seq":2,"at":"now","type":"finished","answer":{"returned":null}}\n',
		),
	);
	const [one, two] = await Promise.all([first, second]);
	expect(one).toEqual(two);
	expect(one.map((event) => event.type)).toEqual(['accepted', 'finished']);
	expect(requests).toBe(1);
});

test('an admitted observer-limit response reconnects by GET', async () => {
	journal();
	const methods: string[] = [];
	globalThis.fetch = (async (
		_url: string | URL | Request,
		init?: RequestInit,
	) => {
		methods.push(init?.method ?? 'GET');
		if (init?.method === 'POST')
			return Response.json(
				{ admitted: true, error: { message: 'busy' } },
				{ status: 429 },
			);
		return new Response(
			'{"seq":1,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as unknown as typeof fetch;
	expectOk(await runs.start(app.start, {}).result());
	expect(methods).toEqual(['POST', 'GET']);
});

test('aborting during onYield stops observation before later buffered values', async () => {
	journal();
	globalThis.fetch = (async () =>
		new Response(
			'{"seq":1,"at":"now","type":"yielded","value":1}\n{"seq":2,"at":"now","type":"yielded","value":2}\n{"seq":3,"at":"now","type":"finished","answer":{"returned":null}}\n',
		)) as unknown as typeof fetch;
	const run = runs.start(app.start, {});
	const stop = new AbortController();
	const seen: unknown[] = [];
	const answer = await run.result({
		signal: stop.signal,
		onYield: async (value) => {
			seen.push(value);
			stop.abort();
			await Promise.resolve();
		},
	});
	expect(seen).toEqual([1]);
	expect(expectErr(answer)).toMatchObject({
		name: 'Stopped',
		run: { id: run.id },
	});
});

test('result with onYield replays yields after events consumed the terminal', async () => {
	journal();
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		return new Response(
			'{"seq":1,"at":"now","type":"yielded","value":1}\n{"seq":2,"at":"now","type":"yielded","value":2}\n{"seq":3,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as unknown as typeof fetch;
	const run = runs.start(app.start, {});
	for await (const _event of run.events()) {
		/* consume the run */
	}
	const before = requests;
	expectOk(await run.result());
	expect(requests).toBe(before);
	const values: unknown[] = [];
	expect(
		expectOk(await run.result({ onYield: (value) => values.push(value) })),
	).toBeNull();
	expect(values).toEqual([1, 2]);
});

test('result with onYield fetches older yields when its buffer starts later', async () => {
	journal();
	const requests: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		requests.push(String(url));
		return new Response(
			'{"seq":1,"at":"now","type":"yielded","value":1}\n{"seq":2,"at":"now","type":"yielded","value":2}\n{"seq":3,"at":"now","type":"finished","answer":{"returned":null}}\n',
		);
	}) as unknown as typeof fetch;
	const run = runs.start(app.start, {});
	for await (const _event of run.events({ after: 2 })) {
		/* start after the yields */
	}
	const values: unknown[] = [];
	expectOk(await run.result({ onYield: (value) => values.push(value) }));
	expect(values).toEqual([1, 2]);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEndWith('/events?after=0');
});

test('ordinary and explicit calls create v4 run IDs without crypto.randomUUID', async () => {
	journal();
	const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
	const urls: string[] = [];
	Object.defineProperty(crypto, 'randomUUID', {
		configurable: true,
		value: undefined,
	});
	try {
		globalThis.fetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			expect(init?.method).toBe('POST');
			urls.push(String(url));
			return new Response(
				'{"seq":1,"at":"now","type":"finished","answer":{"returned":null}}\n',
			);
		}) as unknown as typeof fetch;
		expectOk(await app.start());
		const run = runs.start(app.start, {});
		expectOk(await run.result());
		const route =
			/^\/\.runs\/files\/start\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
		expect(urls).toHaveLength(2);
		for (const url of urls) expect(url).toMatch(route);
		expect(urls[1]).toBe(`/.runs/files/start/${run.id}`);
	} finally {
		if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
		else Reflect.deleteProperty(crypto, 'randomUUID');
	}
});
