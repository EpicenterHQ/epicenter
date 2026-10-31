/**
 * Desktop Connections Tests
 *
 * Vocab's desktop connected endpoints (`connections.tauri.ts`): the list in
 * `connections.md` of a real directory standing in for the AppData root
 * (`openDevice` from `@epicenter/folder/node`), each key in an in-memory
 * stand-in for the keychain.
 *
 * Key behaviors:
 * - The list is `connections.md` at the top of the root, with no key in it;
 *   each key is in the keychain under the connection's id, with its endpoint
 * - Reopened, the list has its keys again
 * - A key applies only while the connection names the endpoint it was
 *   saved for, so editing the note by hand cannot redirect it
 * - Removing a connection, or clearing its key, removes the keychain entry
 * - A connection whose key could not be saved is not kept
 * - Every change reads the note again, so one made behind the app's back is kept
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import {
	type ConnectionKeys,
	createKeychainConnections,
	machineConnections,
} from './connections.tauri.js';

const ENDPOINT = 'https://api.openai.com/v1';
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

function memoryKeys({ failWrites = false } = {}) {
	const entries = new Map<string, string>();
	const keys: ConnectionKeys = {
		async get(names) {
			return Object.fromEntries(
				names.flatMap((name) => {
					const entry = entries.get(name);
					return entry === undefined ? [] : [[name, entry]];
				}),
			);
		},
		async set(name, value) {
			if (failWrites) throw new Error('The keychain could not be written');
			if (value === null) entries.delete(name);
			else entries.set(name, value);
		},
	};
	return { entries, keys };
}

async function open({
	root,
	keys = memoryKeys(),
}: {
	root?: string;
	keys?: ReturnType<typeof memoryKeys>;
} = {}) {
	const path = root ?? (await mkdtemp(join(tmpdir(), 'vocab-appdata-')));
	if (root === undefined) roots.push(path);
	const device = unwrap(await openDevice(machineConnections, { path }));
	const connections = createKeychainConnections({
		file: device.connections,
		keys: keys.keys,
	});
	await connections.ready;
	return { connections, root: path, keys };
}

const note = (root: string) => readFile(join(root, 'connections.md'), 'utf8');

test('the list is connections.md at the top of the root, and the key is in the keychain with its endpoint', async () => {
	const { connections, root, keys } = await open();
	const id = await connections.add({
		name: 'OpenAI',
		baseUrl: ENDPOINT,
		apiKey: 'sk-1',
		models: ['gpt-5'],
	});
	expect(connections.getAll()).toEqual([
		{
			id,
			name: 'OpenAI',
			baseUrl: ENDPOINT,
			models: ['gpt-5'],
			apiKey: 'sk-1',
		},
	]);
	expect(await readdir(root)).toEqual(['connections.md']);
	const text = await note(root);
	expect(text).toContain(ENDPOINT);
	expect(text).toContain(id);
	expect(text).not.toContain('sk-1');
	expect(JSON.parse(keys.entries.get(id) ?? 'null')).toEqual({
		endpoint: ENDPOINT,
		key: 'sk-1',
	});
});

test('reopened, the connections have their keys again', async () => {
	const first = await open();
	const id = await first.connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await first.connections.close();
	const { connections } = await open({ root: first.root, keys: first.keys });
	expect(connections.getAll()).toEqual([
		{
			id,
			name: 'api.openai.com',
			baseUrl: ENDPOINT,
			models: [],
			apiKey: 'sk-1',
		},
	]);
});

test('a key is not sent to an endpoint it was not saved for', async () => {
	const first = await open();
	const id = await first.connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await first.connections.close();
	// The note changed behind the app's back.
	const path = join(first.root, 'connections.md');
	await writeFile(
		path,
		(await note(first.root)).replace(ENDPOINT, 'https://evil.example/v1'),
	);
	const { connections } = await open({ root: first.root, keys: first.keys });
	const [record] = connections.getAll();
	expect(record?.id).toBe(id);
	expect(record?.baseUrl).toBe('https://evil.example/v1');
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
	const { connections, keys, root } = await open();
	const id = await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	await connections.remove(id);
	expect(connections.getAll()).toEqual([]);
	expect(keys.entries.size).toBe(0);
	expect(await note(root)).not.toContain(id);
});

test('a connection whose key could not be saved is not kept', async () => {
	const { connections, root } = await open({
		keys: memoryKeys({ failWrites: true }),
	});
	await expect(
		connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' }),
	).rejects.toThrow('keychain');
	expect(connections.getAll()).toEqual([]);
	expect(await note(root)).not.toContain(ENDPOINT);
});

test('reordering keeps every connection, in the new order', async () => {
	const { connections } = await open();
	const first = await connections.add({ baseUrl: ENDPOINT });
	const second = await connections.add({
		baseUrl: 'http://localhost:11434/v1',
	});
	await connections.reorder([second, first]);
	expect(connections.getAll().map(({ id }) => id)).toEqual([second, first]);
	await expect(connections.reorder([first])).rejects.toThrow(
		'each existing id',
	);
});

test('subscribers hear the keys with the list; a change made to the note behind the app is kept by the next', async () => {
	const { connections, root } = await open();
	const heard: unknown[] = [];
	connections.subscribe((records) =>
		heard.push(records.map((record) => record.apiKey ?? record.name)),
	);
	const id = await connections.add({ baseUrl: ENDPOINT, apiKey: 'sk-1' });
	expect(heard.at(-1)).toEqual(['sk-1']);
	await connections.update(id, { apiKey: '' });
	const path = join(root, 'connections.md');
	const other = unwrap(await openDevice(machineConnections, { path: root }));
	const read = unwrap(await other.connections.get({}));
	unwrap(
		await other.connections.update(
			{},
			{
				connections: read.connections.map((entry) => ({
					...entry,
					name: 'Renamed',
				})),
			},
			{ over: read.version },
		),
	);
	expect(await readFile(path, 'utf8')).toContain('Renamed');
	await connections.update(id, { models: ['gpt-5'] });
	expect(connections.getAll()).toMatchObject([
		{ name: 'Renamed', models: ['gpt-5'] },
	]);
});
