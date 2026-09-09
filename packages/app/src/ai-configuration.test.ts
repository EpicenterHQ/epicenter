/**
 * App AI configuration tests.
 * Verifies immutable connection identity, exact legacy selection import, atomic
 * persistence, detached snapshots, and observation bounded by the App lifetime.
 */
import { expect, test } from 'bun:test';
import { createAiConfiguration } from './ai-configuration.js';

function setup() {
	const values = new Map<string, string>();
	let failWrites = false;
	const observers = new Set<() => void>();
	const storage = {
		getItem(key: string) {
			return values.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (failWrites) throw new Error('Storage write failed.');
			values.set(key, value);
		},
		removeItem(key: string) {
			values.delete(key);
		},
	};
	return {
		values,
		observers,
		failWrites() {
			failWrites = true;
		},
		open() {
			return createAiConfiguration({
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

// Identity and persistence

test('rename, rotation, reorder and reload preserve ids and saved selections', () => {
	const fixture = setup();
	const config = fixture.open();
	const first = config.add({
		name: 'First',
		baseUrl: 'https://same',
		apiKey: 'first',
	});
	const second = config.add({
		name: 'First',
		baseUrl: 'https://same',
		apiKey: 'second',
	});
	expect(first).not.toBe(second);
	config.select('chat', { connectionId: first, model: 'manual' });
	config.update(first, {
		name: 'Renamed',
		apiKey: 'rotated',
		baseUrl: 'https://edited',
	});
	config.reorder([second, first]);
	config.close();
	const reopened = fixture.open();
	expect(reopened.read().map(({ id, apiKey }) => ({ id, apiKey }))).toEqual([
		{ id: second, apiKey: 'second' },
		{ id: first, apiKey: 'rotated' },
	]);
	expect(reopened.target('chat', 'manual')).toEqual({
		connectionId: first,
		model: 'manual',
	});
	expect(reopened.target('chat', 'different')).toBeNull();
});

test('delete and recreate never resurrect a saved destination', () => {
	const config = setup().open();
	const input = { name: 'Server', baseUrl: 'https://same' };
	const old = config.add(input);
	config.select('chat', { connectionId: old, model: 'model' });
	config.remove(old);
	const replacement = config.add(input);
	expect(replacement).not.toBe(old);
	expect(config.target('chat', 'model')?.connectionId).toBe(old);
	expect(config.read().some(({ id }) => id === old)).toBe(false);
});

test('failed persistence preserves the previous snapshot and does not notify', () => {
	const fixture = setup();
	const config = fixture.open();
	const id = config.add({ name: 'Server', baseUrl: 'https://same' });
	let changes = 0;
	config.onChange(() => changes++);
	fixture.failWrites();
	expect(() => config.update(id, { apiKey: 'new' })).toThrow(
		'Storage write failed',
	);
	expect(config.read()[0]?.apiKey).toBeUndefined();
	expect(changes).toBe(0);
});

test('input and snapshot mutations cannot bypass persistence', () => {
	const config = setup().open();
	const models = ['one'];
	config.add({ name: 'Server', baseUrl: 'https://same', models });
	models.push('two');
	const snapshot = config.read();
	snapshot[0]!.name = 'Changed';
	snapshot[0]!.models.push('three');
	expect(config.read()[0]).toMatchObject({ name: 'Server', models: ['one'] });
});

// Migration and malformed storage

test('legacy import maps only a unique exact URL and preserves ambiguous and hosted selections', () => {
	const fixture = setup();
	const legacy = JSON.stringify([
		{ baseUrl: 'https://unique', apiKey: 'secret', models: ['model'] },
		{ baseUrl: 'https://duplicate', apiKey: 'one' },
		{ baseUrl: 'https://duplicate', apiKey: 'two' },
	]);
	fixture.values.set('test.inference-connections', legacy);
	fixture.values.set(
		'test.inference-targets',
		JSON.stringify(
			Object.fromEntries(
				[
					'https://unique',
					'https://duplicate',
					'https://missing',
					'hosted',
				].map((id) => [id, { connectionId: id, model: 'model' }]),
			),
		),
	);
	const config = fixture.open();
	expect(config.target('https://unique', 'model')?.connectionId).toBe(
		config.read()[0]?.id,
	);
	for (const id of ['https://duplicate', 'https://missing', 'hosted']) {
		expect(config.target(id, 'model')).toEqual({
			connectionId: `unresolved:${id}`,
			model: 'model',
		});
	}
	expect(
		config
			.read()
			.slice(1)
			.map(({ apiKey }) => apiKey),
	).toEqual(['one', 'two']);
	expect(fixture.values.get('test.inference-connections')).toBe(legacy);
	fixture.values.set('test.inference-connections', 'invalid backup');
	expect(fixture.open().read()).toEqual(config.read());
});

test('failed migration write leaves legacy settings intact and publishes no envelope', () => {
	const fixture = setup();
	const legacy = JSON.stringify([{ baseUrl: 'https://server' }]);
	fixture.values.set('test.inference-connections', legacy);
	fixture.failWrites();
	expect(() => fixture.open()).toThrow('Storage write failed');
	expect(fixture.values.get('test.inference-connections')).toBe(legacy);
	expect(fixture.values.has('test.app-ai')).toBe(false);
});

test('malformed or unsupported envelopes fail without exposing stored secrets or resetting', () => {
	for (const raw of [
		'secret invalid json',
		JSON.stringify({ version: 2, connections: [], selections: {} }),
		JSON.stringify({
			version: 1,
			connections: [
				{ id: 'x', name: 'n', baseUrl: 'url', apiKey: 'secret', models: [1] },
			],
			selections: {},
		}),
	]) {
		const fixture = setup();
		fixture.values.set('test.app-ai', raw);
		expect(() => fixture.open()).toThrow(
			'Invalid persisted App AI configuration.',
		);
		expect(fixture.values.get('test.app-ai')).toBe(raw);
	}
});

// Observation and closure

test('same-tab writes and external updates notify while close releases observation', () => {
	const fixture = setup();
	const config = fixture.open();
	const { read, add } = config;
	let changes = 0;
	config.onChange(() => changes++);
	add({ name: 'Local', baseUrl: 'https://local' });
	expect(changes).toBe(1);
	fixture.externalChange();
	expect(changes).toBe(1);
	fixture.values.set(
		'test.app-ai',
		JSON.stringify({ version: 1, connections: [], selections: {} }),
	);
	fixture.externalChange();
	expect(read()).toEqual([]);
	expect(changes).toBe(2);
	config.close();
	config.close();
	expect(fixture.observers.size).toBe(0);
	expect(() => read()).toThrow('closed');
	expect(() => add({ name: 'Later', baseUrl: 'https://later' })).toThrow(
		'closed',
	);
});
