/**
 * Custom connection storage tests.
 * Verifies stable IDs, credential isolation in saved records, atomic snapshots,
 * strict validation, and subscription release without owning workflow choices.
 */
import { expect, test } from 'bun:test';
import { createAiConnections } from './ai-connections.js';

function setup() {
	const values = new Map<string, string>();
	const observers = new Set<() => void>();
	let fail = false;
	const storage = {
		getItem(key: string) {
			return values.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (fail) throw new Error('Storage write failed.');
			values.set(key, value);
		},
	};
	return {
		values,
		observers,
		failWrites() {
			fail = true;
		},
		open() {
			return createAiConnections({
				storage,
				storageKey: 'test',
				subscribeStorage(listener) {
					observers.add(listener);
					return () => {
						observers.delete(listener);
					};
				},
			});
		},
		externalChange() {
			for (const listener of observers) listener();
		},
	};
}

test('rename, key rotation, reorder, and reopen preserve independent same-URL IDs', async () => {
	const fixture = setup();
	const connections = fixture.open();
	const first = await connections.add({
		baseUrl: 'https://same',
		apiKey: 'first',
	});
	const second = await connections.add({
		baseUrl: 'https://same',
		apiKey: 'second',
	});
	await connections.update(first, { name: 'Renamed', apiKey: 'rotated' });
	await connections.reorder([second, first]);
	connections.close();
	expect(first).not.toBe(second);
	expect(
		fixture
			.open()
			.getAll()
			.map(({ id, apiKey }) => ({ id, apiKey })),
	).toEqual([
		{ id: second, apiKey: 'second' },
		{ id: first, apiKey: 'rotated' },
	]);
	expect([...fixture.values.keys()]).toEqual(['test.app-ai-connections']);
});

test('delete and recreate uses a new ID while input and snapshot mutations stay detached', async () => {
	const connections = setup().open();
	const models = ['manual'];
	const id = await connections.add({ baseUrl: 'https://same', models });
	models.push('later');
	connections.getAll()[0]!.models.push('snapshot');
	expect(connections.getAll()[0]!.models).toEqual(['manual']);
	await connections.remove(id);
	expect(await connections.add({ baseUrl: 'https://same' })).not.toBe(id);
});

test('a failed write keeps the previous snapshot and does not notify', async () => {
	const fixture = setup();
	const connections = fixture.open();
	const id = await connections.add({ baseUrl: 'https://same' });
	let changes = 0;
	connections.subscribe(() => changes++);
	fixture.failWrites();
	await expect(connections.update(id, { apiKey: 'secret' })).rejects.toThrow(
		'write failed',
	);
	expect(connections.getAll()[0]!.apiKey).toBeUndefined();
	expect(changes).toBe(1);
});

test('a live owner stays empty after deletion instead of reimporting retained legacy records', async () => {
	const fixture = setup();
	const owner = fixture.open();
	await owner.add({ baseUrl: 'https://old.example' });
	fixture.values.set('test.app-ai', 'retained recovery bytes');
	fixture.values.delete('test.app-ai-connections');
	fixture.externalChange();
	const id = await owner.add({
		baseUrl: 'https://new.example',
		apiKey: 'keep',
	});
	await owner.update(id, { name: 'Renamed', apiKey: undefined });
	expect(owner.getAll()).toHaveLength(1);
	expect(owner.getAll()[0]).toMatchObject({
		id,
		name: 'Renamed',
		apiKey: 'keep',
	});
	owner.close();
});

test('legacy sources remain unread and untouched when opening an empty catalog', () => {
	const fixture = setup();
	for (const key of [
		'test.app-ai',
		'test.inference-connections',
		'test.inference-targets',
	])
		fixture.values.set(key, 'malformed legacy credential bytes');
	const before = [...fixture.values];
	expect(fixture.open().getAll()).toEqual([]);
	expect([...fixture.values]).toEqual(before);
});

test('malformed destinations fail without exposing credentials or resetting saved bytes', async () => {
	for (const raw of [
		'secret invalid json',
		JSON.stringify({ version: 2, connections: [] }),
		JSON.stringify({ version: 1, connections: [], selections: {} }),
	]) {
		const fixture = setup();
		fixture.values.set('test.app-ai-connections', raw);
		expect(() => fixture.open()).toThrow(
			'Invalid persisted App AI connections.',
		);
		expect(fixture.values.get('test.app-ai-connections')).toBe(raw);
	}
});

test('external changes observe only the destination and retained methods reject after close', async () => {
	const fixture = setup();
	const connections = fixture.open();
	let changes = 0;
	connections.subscribe(() => changes++);
	await connections.add({ baseUrl: 'https://saved' });
	fixture.values.set('test.app-ai', 'invalid old bytes');
	fixture.externalChange();
	expect(changes).toBe(2);
	fixture.values.delete('test.app-ai-connections');
	fixture.externalChange();
	expect(connections.getAll()).toEqual([]);
	expect(changes).toBe(3);
	connections.close();
	connections.close();
	expect(fixture.observers.size).toBe(0);
	const { getAll, add, update, remove, reorder, subscribe } = connections;
	for (const call of [
		getAll,
		() => add({ baseUrl: 'x' }),
		() => update('x', {}),
		() => remove('x'),
		() => reorder([]),
		() => subscribe(() => {}),
	])
		await expect((async () => call())()).rejects.toThrow('closed');
});
