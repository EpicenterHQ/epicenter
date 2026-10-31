/**
 * Keychain Connections Tests
 *
 * Vocab's desktop connected endpoints (`connections.tauri.ts`): the list in
 * window storage, each key in the keychain, over in-memory stand-ins for
 * both.
 *
 * Key behaviors:
 * - A key is saved in the keychain with its endpoint, never in the list
 * - Reopened, the list has its keys again
 * - A key applies only while the connection names the endpoint it was
 *   saved for
 * - Removing a connection, or clearing its key, removes the keychain entry
 */
import { expect, test } from 'bun:test';
import { createAiConnections } from '@epicenter/ai/connections';
import {
	type ConnectionKeys,
	createKeychainConnections,
} from './connections.tauri.js';

function memoryStorage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	};
}

function memoryKeys(failWrites = false) {
	const entries = new Map<string, string>();
	const keys: ConnectionKeys = {
		async read(ids) {
			return Object.fromEntries(
				ids.flatMap((id) => {
					const entry = entries.get(id);
					return entry === undefined ? [] : [[id, entry]];
				}),
			);
		},
		async write(id, value) {
			if (failWrites) throw new Error('The keychain could not be written');
			if (value === null) entries.delete(id);
			else entries.set(id, value);
		},
	};
	return { entries, keys };
}

async function open(storage = memoryStorage(), keys = memoryKeys()) {
	const connections = createKeychainConnections(
		keys.keys,
		createAiConnections({ storage, storageKey: 'test' }),
	);
	await connections.ready;
	return { connections, storage, keys };
}

const ENDPOINT = 'https://api.openai.com/v1';

test('a key goes to the keychain with its endpoint, never into the list', async () => {
	const { connections, storage, keys } = await open();
	const id = await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	expect(connections.getAll()).toMatchObject([
		{ id, baseUrl: ENDPOINT, apiKey: 'sk-1' },
	]);
	expect([...storage.values.values()].join()).not.toContain('sk-1');
	expect(JSON.parse(keys.entries.get(id) ?? 'null')).toEqual({
		endpoint: ENDPOINT,
		key: 'sk-1',
	});
});

test('reopened, the connections have their keys again', async () => {
	const first = await open();
	const id = await first.connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await first.connections.close();
	const { connections } = await open(first.storage, first.keys);
	expect(connections.getAll()).toMatchObject([{ id, apiKey: 'sk-1' }]);
});

test('a key is not sent to an endpoint it was not saved for', async () => {
	const first = await open();
	const id = await first.connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await first.connections.close();
	// The list changed behind the app's back.
	for (const [key, value] of first.storage.values)
		first.storage.values.set(
			key,
			value.replace(ENDPOINT, 'https://evil.example/v1'),
		);
	const { connections } = await open(first.storage, first.keys);
	const [record] = connections.getAll();
	expect(record?.id).toBe(id);
	expect(record?.apiKey).toBeUndefined();
});

test('an endpoint changed in the app keeps its key; a cleared key is removed', async () => {
	const { connections, keys } = await open();
	const id = await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await connections.update(id, { baseUrl: 'http://localhost:11434/v1' });
	expect(connections.getAll()).toMatchObject([
		{ baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-1' },
	]);
	await connections.update(id, { apiKey: '' });
	expect(connections.getAll()[0]?.apiKey).toBeUndefined();
	expect(keys.entries.has(id)).toBe(false);
});

test('removing a connection removes its key', async () => {
	const { connections, keys } = await open();
	const id = await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await connections.remove(id);
	expect(connections.getAll()).toEqual([]);
	expect(keys.entries.size).toBe(0);
});

test('a connection whose key could not be saved is not kept', async () => {
	const { connections } = await open(memoryStorage(), memoryKeys(true));
	await expect(
		connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' }),
	).rejects.toThrow('keychain');
	expect(connections.getAll()).toEqual([]);
});

test('subscribers hear the keys with the list', async () => {
	const { connections } = await open();
	const heard: unknown[] = [];
	connections.subscribe((records) =>
		heard.push(records.map((record) => record.apiKey)),
	);
	await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	expect(heard.at(-1)).toEqual(['sk-1']);
});
