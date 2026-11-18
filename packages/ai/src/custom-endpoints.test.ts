/**
 * The person's connected endpoints (`customEndpoints`) over a list and keys
 * kept in memory, as an app keeps them in its own files and key store.
 *
 * Key behaviors:
 * - A connection record never holds its key; the key is kept by id, and
 *   `hasApiKey` says it applies at the connection's base URL
 * - An endpoint reads its key as each request leaves, and stays the same
 *   value while its connection does not change
 * - A base URL changed in the app keeps its key; a cleared key is
 *   forgotten, and so is a removed connection's
 * - Reordering keeps every connection; a change to the list is heard
 * - A list that does not read merges nothing and is named; adding a
 *   connection replaces it
 */
import { expect, test } from 'bun:test';
import {
	type ConnectionRecord,
	type ConnectionStore,
	customEndpoints,
} from './custom-endpoints.js';

function memoryStore() {
	let records: readonly ConnectionRecord[] = [];
	let problem: { message: string } | null = null;
	const listeners = new Set<() => void>();
	const tell = () => {
		for (const listener of listeners) listener();
	};
	const store: ConnectionStore = {
		list: () => records,
		problem: () => problem,
		async save(list) {
			records = structuredClone([...list]);
			problem = null;
			tell();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const kept = new Map<string, string>();
	return {
		store,
		kept,
		keys: {
			get: async (id: string) => kept.get(id) ?? null,
			set: async (id: string, key: string | null) => {
				if (key === null) kept.delete(id);
				else kept.set(id, key);
			},
		},
		/** Another writer replaces the list, or leaves one that does not read. */
		outside(list: readonly ConnectionRecord[] | null) {
			if (list === null) problem = { message: 'settings.md does not read' };
			else records = list;
			tell();
		},
	};
}

function recordingFetch() {
	const calls: { url: string; init?: RequestInit }[] = [];
	return {
		calls,
		fetch: async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return Response.json({ data: [] });
		},
	};
}

test('a connection never holds its key, which is kept by id and sent as a request leaves', async () => {
	const memory = memoryStore();
	const { calls, fetch } = recordingFetch();
	const connections = customEndpoints({ ...memory, fetch });
	const id = await connections.add({
		baseUrl: 'https://api.example.com/v1',
		apiKey: ' sk-secret ',
		models: ['m'],
	});
	expect(JSON.stringify(memory.store.list())).not.toContain('sk-secret');
	expect(memory.store.list()[0]?.key).toBe('https://api.example.com/v1');
	expect(memory.kept.get(id)).toBe('sk-secret');
	expect(connections.list()).toEqual([
		{
			id,
			name: 'api.example.com',
			baseUrl: 'https://api.example.com/v1',
			models: ['m'],
			hasApiKey: true,
		},
	]);
	const [endpoint] = connections.endpoints();
	expect(endpoint?.id).toBe(id);
	expect(connections.endpoints()[0]).toBe(endpoint);
	await endpoint?.fetch('models');
	expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
		'Bearer sk-secret',
	);
	// A key changed after the endpoint was made is the one the next request sends.
	memory.kept.set(id, 'sk-new');
	await endpoint?.fetch('models');
	expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe(
		'Bearer sk-new',
	);
});

test('a key is sent only at the base URL it was entered for', async () => {
	const memory = memoryStore();
	const { calls, fetch } = recordingFetch();
	const connections = customEndpoints({ ...memory, fetch });
	const id = await connections.add({
		baseUrl: 'https://a.example.com/v1',
		apiKey: 'sk-a',
	});
	// Another writer moved the connection without its key.
	memory.outside([
		{
			...(memory.store.list()[0] as ConnectionRecord),
			baseUrl: 'https://evil.test/v1',
		},
	]);
	expect(connections.list()[0]?.hasApiKey).toBe(false);
	await connections.endpoints()[0]?.fetch('models');
	expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull();
	expect(memory.kept.get(id)).toBe('sk-a');
});

test('a base URL changed keeps its key; a cleared key and a removed connection forget it', async () => {
	const memory = memoryStore();
	const connections = customEndpoints(memory);
	const id = await connections.add({
		baseUrl: 'https://a.example.com/v1',
		apiKey: 'sk-a',
	});
	await connections.update(id, { baseUrl: 'https://b.example.com/v1' });
	expect(connections.list()[0]?.hasApiKey).toBe(true);
	expect(memory.kept.get(id)).toBe('sk-a');
	await connections.update(id, { apiKey: '' });
	expect(connections.list()[0]?.hasApiKey).toBe(false);
	expect(memory.kept.has(id)).toBe(false);
	await connections.update(id, { apiKey: 'sk-b' });
	await connections.remove(id);
	expect(connections.list()).toEqual([]);
	expect(memory.kept.size).toBe(0);
});

test('reordering keeps every connection, and a change to the list is heard', async () => {
	const memory = memoryStore();
	const connections = customEndpoints(memory);
	const first = await connections.add({ baseUrl: 'https://one.test/v1' });
	const second = await connections.add({ baseUrl: 'https://two.test/v1' });
	await connections.reorder([second, first]);
	expect(connections.list().map(({ id }) => id)).toEqual([second, first]);
	await expect(connections.reorder([first])).rejects.toThrow(
		'each existing id',
	);
	let heard = 0;
	const stop = connections.subscribe(() => heard++);
	memory.outside([
		{
			id: 'other',
			name: 'Other',
			baseUrl: 'https://other.test/v1',
			models: [],
		},
	]);
	expect(heard).toBeGreaterThan(0);
	expect(connections.list().map(({ id }) => id)).toEqual(['other']);
	stop();
});

test('a list that does not read merges nothing and is named; adding replaces it', async () => {
	const memory = memoryStore();
	const connections = customEndpoints(memory);
	memory.outside(null);
	expect(connections.endpoints()).toEqual([]);
	expect(connections.problem()?.message).toContain('settings.md');
	await connections.add({ baseUrl: 'https://x.test/v1' });
	expect(connections.problem()).toBeNull();
	expect(connections.endpoints()).toHaveLength(1);
});
