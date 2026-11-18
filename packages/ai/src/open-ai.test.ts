/**
 * Endpoints and their merge: where an HTTP endpoint sends and with what
 * credential, and how
 * `openAi` orders models, tells subscribers, and routes a request to the
 * endpoint it names.
 */
import { expect, test } from 'bun:test';
import { custom } from './custom.js';
import { type ConnectionRecord, customEndpoints } from './custom-endpoints.js';
import type { Endpoint } from './endpoint.js';
import { openAi } from './open-ai.js';

function recordingFetch() {
	const calls: { url: string; init?: RequestInit }[] = [];
	return {
		calls,
		fetch: async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ text: 'ok', data: [] });
		},
	};
}

test('an HTTP endpoint sends under its base URL with its key and never elsewhere', async () => {
	const { calls, fetch } = recordingFetch();
	const endpoint = custom({
		baseUrl: 'https://api.example.test/v1/',
		key: ' sk-test ',
		fetch,
	});
	await endpoint.fetch('chat/completions', {
		headers: { authorization: 'Bearer stolen', cookie: 'a=b' },
	});
	expect(calls[0]?.url).toBe('https://api.example.test/v1/chat/completions');
	const headers = new Headers(calls[0]?.init?.headers);
	expect(headers.get('authorization')).toBe('Bearer sk-test');
	expect(headers.get('cookie')).toBeNull();
	expect(calls[0]?.init?.credentials).toBe('omit');
	expect(calls[0]?.init?.redirect).toBe('error');
	await expect(endpoint.fetch('https://elsewhere.test/x')).rejects.toThrow();
	await expect(endpoint.fetch('../../escape')).rejects.toThrow();
	await expect(
		custom({ baseUrl: 'https://u:p@x.test/v1' }).fetch('models'),
	).rejects.toThrow('Not an endpoint base URL');
});

test('a custom endpoint guesses what each listed id can do', () => {
	const endpoint = custom({
		id: 'mine',
		baseUrl: 'https://api.example.test/v1',
		models: [
			'gpt-x',
			'whisper-large',
			'text-embedding-3',
			{ id: 'tts', can: [] },
		],
	});
	expect(endpoint.name).toBe('api.example.test');
	expect(endpoint.models()).toEqual([
		{ id: 'gpt-x', can: ['chat'] },
		{ id: 'whisper-large', can: ['transcribe'] },
		{ id: 'text-embedding-3', can: ['embed'] },
		{ id: 'tts', can: [] },
	]);
});

test('an HTTP endpoint names its base URL, and a refusal never repeats its key', async () => {
	const endpoint = custom({
		baseUrl: 'https://api.example.test/v1/',
		key: 'sk-secret',
		fetch: async () =>
			Response.json(
				{ error: { message: 'Incorrect API key provided: sk-secret' } },
				{ status: 401 },
			),
	});
	expect(endpoint.baseUrl).toBe('https://api.example.test/v1');
	const refused = await endpoint.fetch('models');
	expect(refused.status).toBe(401);
	const body = await refused.text();
	expect(body).not.toContain('sk-secret');
	expect(body).toContain('[key removed]');
});

function probing(id: string, source: Endpoint['source']) {
	let models: { id: string; can: ['chat'] }[] = [];
	const listeners = new Set<() => void>();
	const endpoint: Endpoint = {
		id,
		name: id,
		source,
		fetch: async () => Response.json({ text: `from ${id}` }),
		models: () => models,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		endpoint,
		listeners,
		find(...ids: string[]) {
			models = ids.map((model) => ({ id: model, can: ['chat'] }));
			for (const listener of listeners) listener();
		},
	};
}

test('openAi lists models in the array order, skipping null and flattening groups', () => {
	const local = probing('ollama', 'local');
	const ai = openAi([
		[local.endpoint, null],
		null,
		custom({ id: 'key', baseUrl: 'https://x.test/v1', models: ['m'] }),
	]);
	local.find('llama');
	expect(
		ai.models().map(({ endpoint, source, id }) => [endpoint, source, id]),
	).toEqual([
		['ollama', 'local', 'llama'],
		['key', 'custom', 'm'],
	]);
	expect(ai.endpoints().map(({ id }) => id)).toEqual(['ollama', 'key']);
});

test('openAi refuses two endpoints with one id', () => {
	expect(() =>
		openAi([
			custom({ baseUrl: 'https://x.test/v1' }),
			custom({ baseUrl: 'https://x.test/v1' }),
		]),
	).toThrow('share the id');
});

test('subscribe tells each subscriber when any endpoint changes, until it stops', () => {
	const first = probing('a', 'local');
	const second = probing('b', 'local');
	const ai = openAi([first.endpoint, second.endpoint]);
	let told = 0;
	const stop = ai.subscribe(() => told++);
	first.find('x');
	second.find('y');
	expect(told).toBe(2);
	stop();
	first.find('z');
	expect(told).toBe(2);
	expect(first.listeners.size).toBe(0);
});

test('refresh asks every endpoint that probes to look again', async () => {
	let refreshed = 0;
	const ai = openAi([
		{
			...probing('a', 'local').endpoint,
			refresh: async () => {
				refreshed++;
			},
		},
		custom({ baseUrl: 'https://x.test/v1' }),
	]);
	await ai.refresh();
	expect(refreshed).toBe(1);
});

test('a request goes to the endpoint it names, and an unknown one is NoEndpoint', async () => {
	const ai = openAi([
		probing('a', 'local').endpoint,
		probing('b', 'local').endpoint,
	]);
	const sent = await ai.transcribe({
		endpoint: 'b',
		model: 'm',
		file: new Blob(['x']),
	});
	expect(sent.data).toEqual({ text: 'from b' });
	const missing = await ai.transcribe({
		endpoint: 'gone',
		model: 'm',
		file: new Blob(['x']),
	});
	expect(missing.error).toMatchObject({ name: 'NoEndpoint', endpoint: 'gone' });
	const chat = [];
	for await (const item of ai.chat({
		endpoint: 'gone',
		model: 'm',
		messages: [],
	}))
		chat.push(item);
	expect(chat.map(({ error }) => error?.name)).toEqual(['NoEndpoint']);
});

test('a live entry is read at every use: a connection added reaches the merge it is in, and nested merges', async () => {
	let records: readonly ConnectionRecord[] = [];
	const listeners = new Set<() => void>();
	const connections = customEndpoints({
		store: {
			list: () => records,
			problem: () => null,
			async save(list) {
				records = list;
				for (const listener of listeners) listener();
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		keys: { get: async () => null, set: async () => {} },
	});
	const ai = openAi([
		openAi([connections]),
		probing('ollama', 'local').endpoint,
	]);
	expect(ai.endpoints().map(({ id }) => id)).toEqual(['ollama']);
	expect(ai.custom()).toBe(connections);

	let told = 0;
	const stop = ai.subscribe(() => told++);
	const id = await connections.add({
		name: 'Mine',
		baseUrl: 'https://x.test/v1',
		models: ['m'],
	});
	expect(told).toBeGreaterThan(0);
	expect(ai.endpoints().map((endpoint) => endpoint.id)).toEqual([id, 'ollama']);
	expect(ai.models().map(({ endpoint, id }) => `${endpoint}/${id}`)).toEqual([
		`${id}/m`,
	]);
	stop();
});

test('an endpoint a live entry adds is subscribed to as it arrives, and one it drops is let go', async () => {
	const first = probing('a', 'local');
	const second = probing('b', 'local');
	let current = [first.endpoint];
	const listeners = new Set<() => void>();
	const live = {
		endpoints: () => current,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const ai = openAi([live]);
	const stop = ai.subscribe(() => {});
	expect(first.listeners.size).toBe(1);
	current = [second.endpoint];
	for (const listener of listeners) listener();
	expect(first.listeners.size).toBe(0);
	expect(second.listeners.size).toBe(1);
	stop();
	expect(second.listeners.size).toBe(0);
	expect(listeners.size).toBe(0);
});
