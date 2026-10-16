/**
 * The browser workspace's own storage: microphone preference failures reach
 * the chooser rather than becoming System default, and connections are rows
 * of this origin's `so.epicenter` whose endpoints and keys stay in this
 * browser, sent only to the endpoint a request was prepared for.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CONNECTIONS_FOLDER_ID,
	epicenterDefinition,
} from '@epicenter/ai/connection-table';
import { openFolder as openBunFolder } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { transformationRequest } from '../requests.js';
import { openTestWorkspace } from '../workspace.test-support.js';
import type { ConnectionsFolder, Workspace } from './types.js';

// Compile the Vite build flag for this adapter test; no microphone is opened.
Bun.plugin({
	name: 'browser-workspace-build-flag',
	setup(build) {
		build.onLoad({ filter: /\/workspace\/browser\.ts$/ }, async ({ path }) => ({
			contents: new Bun.Transpiler({
				loader: 'ts',
				define: { 'import.meta.env.DEV': 'false' },
			}).transformSync(await Bun.file(path).text()),
			loader: 'js',
		}));
	},
});

let folder: Workspace['folder'];
let connectionsFolder: ConnectionsFolder | undefined;
mock.module('@epicenter/folder/browser', () => ({
	// Whispering's own folder, or this origin's `so.epicenter`.
	openFolder: async (options: { id: string }) => {
		if (options.id === CONNECTIONS_FOLDER_ID) {
			connectionsFolder ??= expectOk(
				await openBunFolder({
					root: await realpath(
						await mkdtemp(join(tmpdir(), 'whispering-browser-connections-')),
					),
					definition: epicenterDefinition,
					git: { author: { name: 'Test', email: 'test@localhost' } },
				}),
			);
			return Ok(connectionsFolder);
		}
		expect(options.id).toBe('so.epicenter.whispering');
		return Ok(folder);
	},
}));
const { openWorkspace: openBrowserWorkspace } = await import('./browser.js');
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
	for (const cleanup of cleanups.splice(0)) await cleanup();
	connectionsFolder = undefined;
	for (const [name, descriptor] of [
		['localStorage', originalStorage],
		['location', originalLocation],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function preferences(getItem: (key: string) => string | null) {
	const workspace = await openTestWorkspace();
	folder = workspace.workspace.folder;
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	const browser = expectOk(await openBrowserWorkspace());
	cleanups.push(async () => {
		await browser.close();
		await workspace.remove();
	});
	return browser.preferences;
}

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
const chat = () =>
	transformationRequest({
		model: 'chat-model',
		prompt: 'Fix it.',
		input: 'some text',
	});

/** A browser workspace over storage held in `stored`, with every request it sends recorded. */
async function browserWithStorage(stored: Map<string, string>) {
	const workspace = await openTestWorkspace();
	folder = workspace.workspace.folder;
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
	let reachable = true;
	globalThis.fetch = (async (input: string, init: RequestInit) => {
		const request = new Request(input, init);
		sent.push({
			url: request.url,
			authorization: request.headers.get('authorization'),
			init,
		});
		if (!reachable) throw new TypeError('Failed to fetch');
		return Response.json({ choices: [{ message: { content: 'ok' } }] });
	}) as unknown as typeof fetch;
	const browser = expectOk(await openBrowserWorkspace());
	cleanups.push(async () => {
		globalThis.fetch = originalFetch;
		await browser.close();
		await workspace.remove();
	});
	return {
		browser,
		sent,
		unreachable: () => {
			reachable = false;
		},
	};
}

test('a browser keeps a connection’s endpoint and key under its row’s id, never in the row, and sends only to that endpoint', async () => {
	const stored = new Map<string, string>();
	const { browser, sent } = await browserWithStorage(stored);
	const { connections } = browser;
	expect(connections.kinds).toEqual(['openai-compatible']);
	expect(browser.localTranscription).toBeUndefined();
	expect((await connections.epicenterEndpoint()).error).toBeTruthy();

	const opened = expectOk(await connections.open());
	expectOk(
		await opened.tables.connections.create(
			{ fields: { kind: 'openai-compatible', title: 'Groq', model: 'chat-model' }, body: '' },
			{ stem: 'groq' },
		),
	);
	expectOk(await connections.keys.save('groq', `${BASE_URL}/`, 'text-key'));
	expect(JSON.parse(stored.get('so.epicenter.secret.groq')!)).toEqual({
		endpoint: BASE_URL,
		key: 'text-key',
	});
	const row = expectOk(await opened.tables.connections.get('groq'))!;
	expect(JSON.stringify(row)).not.toContain('text-key');
	expect(JSON.stringify(row)).not.toContain(BASE_URL);

	const target = { kind: 'openai-compatible', connection: 'groq' } as const;
	for (const elsewhere of [
		'http://127.0.0.1:18080/other/v1',
		'https://api.openai.com/v1',
	]) {
		const { error } = await connections.send(
			{ ...target, endpoint: elsewhere },
			chat(),
		);
		expect(error?.message).toContain(`saved for ${BASE_URL}`);
	}
	expect(sent).toEqual([]);
	const response = expectOk(
		await connections.send({ ...target, endpoint: BASE_URL }, chat()),
	);
	expect(response.ok).toBe(true);
	expect(sent).toMatchObject([
		{
			url: `${BASE_URL}/chat/completions`,
			authorization: 'Bearer text-key',
			init: { redirect: 'error', credentials: 'omit' },
		},
	]);
});

test('nothing an earlier build kept in this browser is read, moved, or removed', async () => {
	const earlier = new Map([
		['whispering.connections', '{"text": {"baseUrl": "http://127.0.0.1:18080/v1", "model": "m", "apiKey": "old"}}'],
		['whispering.transcriptionApiKey', 'earlier-key'],
	]);
	const stored = new Map(earlier);
	const { browser, sent } = await browserWithStorage(stored);
	const opened = expectOk(await browser.connections.open());

	expect(expectOk(await opened.tables.connections.list())).toEqual([]);
	expect(stored).toEqual(earlier);
	expect(sent).toEqual([]);
});

test('an endpoint a browser cannot reach says what a tab needs that Epicenter does not', async () => {
	const stored = new Map<string, string>();
	const { browser, unreachable } = await browserWithStorage(stored);
	expectOk(await browser.connections.keys.save('local', BASE_URL, ''));
	unreachable();

	const { error } = await browser.connections.send(
		{ kind: 'openai-compatible', connection: 'local', endpoint: BASE_URL },
		chat(),
	);
	expect(error?.message).toContain(
		'must allow requests from http://localhost:5199 (CORS)',
	);
});
