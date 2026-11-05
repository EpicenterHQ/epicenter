/**
 * The person's connected endpoints (`customEndpoints()`) over this
 * computer's settings in memory (the `test` condition), with the web's keys
 * (`device-settings.ts`, the build's default leaf).
 *
 * Key behaviors:
 * - A connection is `connections.md`, never its key; the key is kept apart
 *   with the endpoint it was entered for, and `hasApiKey` says it applies
 * - An endpoint carries the key that applies to it, and stays the same
 *   value while neither its connection nor its key changes
 * - An endpoint changed in the app keeps its key; a cleared key is
 *   forgotten, and so is a removed connection's
 * - Reordering keeps every connection; another window's write is heard
 * - A `connections.md` that does not read merges nothing and is named;
 *   adding a connection replaces it
 */
import { expect, test } from 'bun:test';
import { settings } from '@epicenter/local';
import { outside } from '@epicenter/local/memory';
import { customEndpoints } from './custom-endpoints.js';

const list = settings.file('connections.md');
const keys = settings.file('connection-keys.json');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function fresh() {
	const connections = customEndpoints();
	await list.connected();
	outside.write('connections.md', null);
	outside.write('connection-keys.json', null);
	await tick();
	return connections;
}

test('a connection is connections.md, its key kept apart for the endpoint it was entered for', async () => {
	const connections = await fresh();
	const id = await connections.add({
		baseUrl: 'https://api.example.com/v1',
		apiKey: 'sk-secret',
		models: ['m'],
	});
	expect(list.text()).not.toContain('sk-secret');
	expect(list.text()).toContain('key: "https://api.example.com/v1"');
	expect(JSON.parse(keys.text() ?? '{}')).toEqual({
		[id]: { endpoint: 'https://api.example.com/v1', key: 'sk-secret' },
	});
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
});

test('an endpoint changed keeps its key; a cleared key and a removed connection forget it', async () => {
	const connections = await fresh();
	const id = await connections.add({
		baseUrl: 'https://a.example.com/v1',
		apiKey: 'sk-a',
	});
	await connections.update(id, { baseUrl: 'https://b.example.com/v1' });
	expect(connections.list()[0]?.hasApiKey).toBe(true);
	expect(JSON.parse(keys.text() ?? '{}')[id]).toEqual({
		endpoint: 'https://b.example.com/v1',
		key: 'sk-a',
	});
	await connections.update(id, { apiKey: '' });
	expect(connections.list()[0]?.hasApiKey).toBe(false);
	expect(keys.text()).toBeNull();
	await connections.update(id, { apiKey: 'sk-b' });
	await connections.remove(id);
	expect(connections.list()).toEqual([]);
	expect(keys.text()).toBeNull();
});

test('reordering keeps every connection, and another window’s write is heard', async () => {
	const connections = await fresh();
	const first = await connections.add({ baseUrl: 'https://one.test/v1' });
	const second = await connections.add({ baseUrl: 'https://two.test/v1' });
	await connections.reorder([second, first]);
	expect(connections.list().map(({ id }) => id)).toEqual([second, first]);
	await expect(connections.reorder([first])).rejects.toThrow('each existing id');
	let heard = 0;
	const stop = connections.subscribe(() => heard++);
	outside.write(
		'connections.md',
		'---\nconnections:\n  - id: other\n    name: Other\n    baseUrl: https://other.test/v1\n    models: []\n---\n',
	);
	await tick();
	expect(heard).toBeGreaterThan(0);
	expect(connections.list().map(({ id }) => id)).toEqual(['other']);
	stop();
});

test('a connections.md that does not read merges nothing and is named; adding replaces it', async () => {
	const connections = await fresh();
	outside.write('connections.md', '---\nconnections: [\n---\n');
	await tick();
	expect(connections.endpoints()).toEqual([]);
	expect(connections.problem()).toMatchObject({
		name: 'Invalid',
		file: 'connections.md',
	});
	await connections.add({ baseUrl: 'https://x.test/v1' });
	expect(connections.problem()).toBeNull();
	expect(connections.endpoints()).toHaveLength(1);
});
