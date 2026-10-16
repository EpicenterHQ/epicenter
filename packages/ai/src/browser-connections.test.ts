/**
 * Browser connection tests.
 * Verifies the page's secret store holds what `saveKey` writes, that each
 * kind sends over its own transport so the account's token reaches only the
 * account, and that a bound `fetch` never leaves its endpoint.
 */
import { expect, test } from 'bun:test';
import {
	browserSecrets,
	connectionFetch,
	secretStorageKey,
	sendFromBrowser,
} from './browser-connections.js';
import { keyState, saveKey } from './send.js';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
	};
}

function recordingFetch(label: string, calls: string[]) {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		calls.push(
			`${label} ${request.url} ${request.headers.get('authorization') ?? ''}`.trim(),
		);
		return new Response('{}');
	}) as typeof globalThis.fetch;
}

const request = { method: 'POST', path: 'chat/completions', headers: [] };

test('a saved key is one localStorage entry under the connection id, read back as state only', async () => {
	const storage = memoryStorage();
	const secrets = browserSecrets(storage);
	await saveKey(secrets, 'tutor', {
		endpoint: 'https://example.com/v1/',
		key: 'sk-1',
	});

	expect([...storage.values.keys()]).toEqual([secretStorageKey('tutor')]);
	expect(storage.values.get('so.epicenter.secret.tutor')).toBe(
		JSON.stringify({ endpoint: 'https://example.com/v1', key: 'sk-1' }),
	);
	expect((await keyState(secrets, 'tutor')).data).toEqual({
		state: 'saved',
		endpoint: 'https://example.com/v1',
		hasKey: true,
	});
	expect(await secrets.delete('tutor')).toBe(true);
	expect(await secrets.delete('tutor')).toBe(false);
});

test("the account's token goes only to an epicenter row, and a saved key only to its own", async () => {
	const secrets = browserSecrets(memoryStorage());
	await saveKey(secrets, 'custom', {
		endpoint: 'https://example.com/v1',
		key: 'sk-1',
	});
	const calls: string[] = [];
	const account = {
		baseURL: 'https://api.epicenter.test/',
		fetch: recordingFetch('account', calls),
	};
	const page = recordingFetch('page', calls);

	await sendFromBrowser({
		target: {
			kind: 'openai-compatible',
			connection: 'custom',
			endpoint: 'https://example.com/v1',
		},
		request,
		secrets,
		account,
		fetch: page,
	});
	await sendFromBrowser({
		target: { kind: 'epicenter', connection: 'hosted' },
		request,
		secrets,
		account,
		fetch: page,
	});

	expect(calls).toEqual([
		'page https://example.com/v1/chat/completions Bearer sk-1',
		'account https://api.epicenter.test/v1/chat/completions',
	]);
});

test('signed out, an epicenter row is refused, and a local row always is', async () => {
	const secrets = browserSecrets(memoryStorage());
	const hosted = await sendFromBrowser({
		target: { kind: 'epicenter', connection: 'hosted' },
		request,
		secrets,
	});
	expect(hosted.error?.name).toBe('NoAccessToken');
	const local = await sendFromBrowser({
		target: { kind: 'local', connection: 'device' },
		request,
		secrets,
	});
	expect(local.error?.name).toBe('LocalNotSent');
});

test('a bound fetch refuses a URL outside its endpoint and sends nothing', async () => {
	const calls: string[] = [];
	const bound = connectionFetch({
		target: { kind: 'epicenter', connection: 'hosted' },
		endpoint: 'https://api.epicenter.test/v1',
		account: {
			baseURL: 'https://api.epicenter.test',
			fetch: recordingFetch('account', calls),
		},
	});

	await expect(bound('https://elsewhere.test/v1/models')).rejects.toThrow(
		'is not below the endpoint',
	);
	await bound('https://api.epicenter.test/v1/models');
	expect(calls).toEqual(['account https://api.epicenter.test/v1/models']);
});
