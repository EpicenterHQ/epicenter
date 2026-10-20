/**
 * Browser capture, connections, and microphone preferences over an opened folder.
 * Provider requests read audio from that folder and use only their prepared
 * connection. Malformed device settings remain visible rather than overwritten.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { toneWav } from '../capture.js';
import { whisperingTables } from '../definition.js';
import { readBytes } from '../files.js';
import { openTestServices } from '../services.test-support.js';
import type { WhisperingFolder } from '../folder.js';

// Compile the Vite build flag for this adapter test; no microphone is opened.
Bun.plugin({
	name: 'browser-services-build-flag',
	setup(build) {
		build.onLoad({ filter: /\/platform\/browser\.ts$/ }, async ({ path }) => ({
			contents: new Bun.Transpiler({
				loader: 'ts',
				define: { 'import.meta.env.DEV': 'false' },
			}).transformSync(await Bun.file(path).text()),
			loader: 'js',
		}));
	},
});

let folder: WhisperingFolder;
/** What the next opening answers instead of the folder, when set. */
let refusal: Result<never, OpenFolderError> | undefined;
mock.module('@epicenter/folder/browser', () => ({
	openFolder: async (options: Record<string, unknown>) => {
		// The tables alone: no app, ID, definition, author, or credentials.
		expect(options).toEqual({ tables: whisperingTables });
		return refusal ?? Ok(folder);
	},
}));
const { createServices } = await import('./browser.js');
const { openFolder } = await import('@epicenter/folder/browser');
const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
const originalLocation = Object.getOwnPropertyDescriptor(
	globalThis,
	'location',
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	refusal = undefined;
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const [name, descriptor] of [
		['localStorage', originalStorage],
		['location', originalLocation],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function preferences(getItem: (key: string) => string | null) {
	const services = await openTestServices();
	folder = services.folder;
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	const browser = createServices(expectOk(await openFolder({ tables: whisperingTables })));
	cleanups.push(async () => {
		await folder.close();
		await services.remove();
	});
	return browser.preferences;
}

test('browser storage failure is reported without opening another folder', async () => {
	refusal = OpenFolderError.Unavailable({ cause: new Error('storage denied') });

	const refused = expectErr(await openFolder({ tables: whisperingTables }));

	expect(refused.name).toBe('Unavailable');
	expect(refused.message).toContain('storage denied');
});

test('a recording’s audio is read back from the folder as its exact bytes for transcription', async () => {
	const services = await openTestServices();
	folder = services.folder;
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	expectOk(await folder.files.write('audio/take.webm', null, toneWav()));
	const browser = createServices(expectOk(await openFolder({ tables: whisperingTables })));
	cleanups.push(async () => {
		await folder.close();
		await services.remove();
	});

	expect(expectOk(await readBytes(folder, 'audio/take.webm'))).toEqual(
		toneWav(),
	);
});

test('missing and valid microphone preferences retain their meaning', async () => {
	let saved: string | null = null;
	const reader = await preferences((key) => {
		expect(key).toBe('whispering.microphone');
		return saved;
	});
	expect(await reader.microphone()).toBeUndefined();
	saved = JSON.stringify({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
	expect(await reader.microphone()).toEqual({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
});

test('a refused storage read rejects instead of selecting System default', async () => {
	const reader = await preferences(() => {
		throw new Error('Storage access refused');
	});
	await expect(reader.microphone()).rejects.toThrow('Storage access refused');
});

test('malformed microphone JSON rejects instead of selecting System default', async () => {
	const reader = await preferences(() => '{broken');
	await expect(reader.microphone()).rejects.toBeInstanceOf(SyntaxError);
});

// ============================================================================
// Connections in this browser's storage
// ============================================================================

const BASE_URL = 'http://127.0.0.1:18080/v1';
const prepared = (expectedBaseUrl: string) => ({
	expectedBaseUrl,
	model: 'chat-model',
	prompt: 'Fix it.',
	input: 'some text',
});

/** A browser services over storage held in `stored`, with every request it sends recorded. */
async function browserWithStorage(stored: Map<string, string>) {
	const services = await openTestServices();
	folder = services.folder;
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => void stored.set(key, value),
			removeItem: (key: string) => void stored.delete(key),
		},
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	const sent: {
		url: string;
		authorization: string | null;
		init: RequestInit;
	}[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string, init: RequestInit) => {
		const request = new Request(input, init);
		sent.push({
			url: request.url,
			authorization: request.headers.get('authorization'),
			init,
		});
		return Response.json({ choices: [{ message: { content: 'ok' } }] });
	}) as unknown as typeof fetch;
	const browser = createServices(expectOk(await openFolder({ tables: whisperingTables })));
	cleanups.push(async () => {
		globalThis.fetch = originalFetch;
		await folder.close();
		await services.remove();
	});
	return { browser, sent };
}

test('a browser keeps connections and keys in its own storage, tells the page no key, and sends only to the connection it was prepared for', async () => {
	const stored = new Map<string, string>();
	const { browser, sent } = await browserWithStorage(stored);
	expect(await browser.connections.read()).toEqual({
		transcription: undefined,
		text: undefined,
	});
	// Nothing is set up, so nothing is sent.
	const { error: unavailable } = await browser.transform(prepared(BASE_URL));
	expect(unavailable?.name).toBe('ConnectionUnavailable');

	const saved = expectOk(
		await browser.connections.set('text', {
			baseUrl: `${BASE_URL}/`,
			model: 'chat-model',
			key: { action: 'replace', key: 'text-key' },
		}),
	);
	expect(JSON.stringify(saved)).not.toContain('text-key');
	expect(JSON.parse(stored.get('whispering.connections')!)).toEqual({
		text: { baseUrl: BASE_URL, model: 'chat-model', apiKey: 'text-key' },
	});

	for (const elsewhere of [
		'http://127.0.0.1:18080/other/v1',
		'https://api.openai.com/v1',
	]) {
		const { error: changed } = await browser.transform(prepared(elsewhere));
		expect(changed?.name).toBe('ConnectionChanged');
	}
	expect(sent).toEqual([]);
	const answer = expectOk(await browser.transform(prepared(BASE_URL)));
	expect(answer?.text).toBe('ok');
	expect(sent).toMatchObject([
		{
			url: `${BASE_URL}/chat/completions`,
			authorization: 'Bearer text-key',
			init: { redirect: 'error', credentials: 'omit' },
		},
	]);

	// A new endpoint cannot keep the key.
	const { error: refusal } = await browser.connections.set('text', {
		baseUrl: 'http://127.0.0.1:18080/other/v1',
		model: 'chat-model',
		key: { action: 'keep' },
	});
	expect(refusal).toContain('saved key is not sent there');
});

test('browser connections that do not read are reported, never taken for none, and never replaced', async () => {
	const stored = new Map([['whispering.connections', '{"text": ']]);
	const { browser, sent } = await browserWithStorage(stored);

	await expect(browser.connections.read()).rejects.toThrow(
		'do not read as a JSON object',
	);
	const { error: refusal } = await browser.connections.set('text', {
		baseUrl: BASE_URL,
		model: 'chat-model',
		key: { action: 'remove' },
	});
	expect(refusal).toContain('do not read as a JSON object');
	expect(stored.get('whispering.connections')).toBe('{"text": ');
	const { error: unavailable } = await browser.transform(prepared(BASE_URL));
	expect(unavailable?.name).toBe('ConnectionUnavailable');
	expect(sent).toEqual([]);
});

test('a malformed browser connection is never replaced by setup', async () => {
	const original = JSON.stringify({
		text: { baseUrl: BASE_URL, model: 7, apiKey: 'recoverable-key' },
	});
	const stored = new Map([['whispering.connections', original]]);
	const { browser, sent } = await browserWithStorage(stored);
	for (const key of [
		{ action: 'keep' },
		{ action: 'remove' },
		{ action: 'replace', key: 'new-key' },
	] as const) {
		const { error: refusal } = await browser.connections.set('text', {
			baseUrl: BASE_URL,
			model: 'chat-model',
			key,
		});
		expect(refusal).toContain('does not read as one');
		expect(stored.get('whispering.connections')).toBe(original);
	}
	expect(sent).toEqual([]);
});
