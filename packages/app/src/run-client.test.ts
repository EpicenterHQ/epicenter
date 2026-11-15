/**
 * Browser-only run behavior: cancellation before admission, observation abort,
 * top-level action names, and file schema constraints without a running host.
 */
import { afterEach, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { defineAction } from './action.ts';
import { connect } from './client.ts';
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
		daily: { begin: typeof empty };
		practice: { begin: typeof empty };
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
	expect(app.upload.pending()).toEqual([pending]);
	expect(app.upload.attach(pending.id).id).toBe(pending.id);
});

test('cancelling before admission sends no request and clears the journal', async () => {
	journal();
	let sent = 0;
	globalThis.fetch = (async () => {
		sent++;
		return new Response();
	}) as unknown as typeof fetch;
	const run = app.upload.start({ file: new Blob(['hello']) });
	expectOk(await run.cancel());
	expect(expectErr(await run.result()).name).toBe('Stopped');
	expect(app.upload.pending()).toEqual([]);
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
	const run = app.upload.attach('unknown-run-identifier');
	expect(
		expectErr(await run.result({ signal: stop.signal })).message,
	).toContain('Stopped waiting');
	expect(sent).toBe(0);
});

test('renamed nested triggers route as calls while action start controls a run', async () => {
	const urls: string[] = [];
	globalThis.fetch = (async (url: string | URL | Request) => {
		urls.push(String(url));
		return new Response('{"answer":{"returned":null}}\n');
	}) as typeof fetch;
	expectOk(await app.start());
	expectOk(await app.daily.begin());
	expectOk(await app.practice.begin());
	expect(urls).toEqual([
		'/files/start',
		'/files/daily.begin',
		'/files/practice.begin',
	]);
	journal();
	const hosted = app.upload.start({ file: new Blob(['hello']) });
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
