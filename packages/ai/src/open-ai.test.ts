/**
 * Endpoints and their merge: where an HTTP endpoint sends and with what
 * credential, what hosted inference lists signed in and out, and how
 * `openAi` orders models, tells subscribers, and routes a request to the
 * endpoint it names.
 */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/account';
import { custom } from './custom.js';
import { type Endpoint, openAiCompatible } from './endpoint.js';
import { hosted } from './hosted.js';
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

function fakeAccount() {
	const lifetime = new AbortController();
	const { calls, fetch } = recordingFetch();
	const account = {
		baseURL: 'https://api.epicenter.test/',
		signal: lifetime.signal,
		fetch,
	} as unknown as Account;
	return { account, calls, retire: () => lifetime.abort() };
}

test('hosted lists the hosted catalog at the account origin, and none once retired', async () => {
	const { account, calls, retire } = fakeAccount();
	const endpoint = hosted(account, { models: ['gpt-5.5', 'whisper-1'] });
	expect(endpoint.models()).toEqual([
		{ id: 'gpt-5.5', can: ['chat'], label: 'Best' },
		{ id: 'whisper-1', can: ['transcribe'] },
	]);
	await endpoint.fetch('audio/transcriptions');
	expect(calls[0]?.url).toBe(
		'https://api.epicenter.test/v1/audio/transcriptions',
	);

	let told = 0;
	endpoint.subscribe?.(() => told++);
	retire();
	expect(told).toBe(1);
	expect(endpoint.models()).toEqual([]);
});

test('hosted while signed out lists nothing and refuses requests as SignedOut', async () => {
	const endpoint = hosted(undefined);
	expect(endpoint.models()).toEqual([]);
	expect(endpoint.baseUrl).toBeUndefined();
	const refusal = await endpoint
		.fetch('chat/completions')
		.catch((cause) => cause);
	expect(refusal.name).toBe('SignedOut');
	expect(refusal.message).toContain('Sign in');
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
		hosted(fakeAccount().account, { models: ['gpt-5.5'] }),
		null,
		custom({ id: 'key', baseUrl: 'https://x.test/v1', models: ['m'] }),
	]);
	local.find('llama');
	expect(
		ai.models().map(({ endpoint, source, id }) => [endpoint, source, id]),
	).toEqual([
		['ollama', 'local', 'llama'],
		['hosted', 'hosted', 'gpt-5.5'],
		['key', 'custom', 'm'],
	]);
	expect(ai.endpoints().map(({ id }) => id)).toEqual([
		'ollama',
		'hosted',
		'key',
	]);
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

test('refresh asks every endpoint that probes to look again', () => {
	let refreshed = 0;
	const ai = openAi([
		{ ...probing('a', 'local').endpoint, refresh: () => refreshed++ },
		custom({ baseUrl: 'https://x.test/v1' }),
	]);
	ai.refresh();
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

test('openAiCompatible takes its models as a live answer', () => {
	let models = [{ id: 'a', can: ['chat'] as const }];
	const endpoint = openAiCompatible({
		id: 'e',
		name: 'E',
		source: 'local',
		baseUrl: 'http://localhost:1/v1',
		models: () => models,
	});
	models = [];
	expect(endpoint.models()).toEqual([]);
});
