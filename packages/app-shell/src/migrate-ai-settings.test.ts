/**
 * AI settings migration tests.
 * Verifies committed stable IDs, exact independent destination precedence,
 * recovery after every failed write, and serialized multi-document conversion.
 */
import { expect, test } from 'bun:test';
import {
	createAiConnections,
	initializeAiConnections,
} from '@epicenter/app/ai-connections';
import { createInferenceSelections } from './inference-selections.js';
import { migrateAiSettings } from './migrate-ai-settings.js';

function setup() {
	const values = new Map<string, string>();
	const writes: string[] = [];
	let failedKey: string | undefined;
	const queues = new Map<string, Promise<unknown>>();
	function request<T>(
		name: string,
		callback: LockGrantedCallback<T>,
	): Promise<T>;
	function request<T>(
		name: string,
		options: LockOptions,
		callback: LockGrantedCallback<T>,
	): Promise<T>;
	function request<T>(
		name: string,
		options: LockOptions | LockGrantedCallback<T>,
		supplied?: LockGrantedCallback<T>,
	): Promise<T> {
		const callback = typeof options === 'function' ? options : supplied!;
		const previous = queues.get(name) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => callback({ name, mode: 'exclusive' }));
		queues.set(name, next);
		return next;
	}
	const options = {
		storageKey: 'test',
		locks: { request },
		storage: {
			getItem(key: string) {
				return values.get(key) ?? null;
			},
			setItem(key: string, value: string) {
				if (key === failedKey) throw new Error('Storage write failed.');
				writes.push(key);
				values.set(key, value);
			},
		},
	};
	return {
		values,
		writes,
		options,
		failAt(key?: string) {
			failedKey = key;
		},
		migrate() {
			return migrateAiSettings(options);
		},
		connections() {
			return createAiConnections(options);
		},
		selections() {
			return createInferenceSelections(options);
		},
	};
}
const record = {
	id: 'saved-id',
	name: 'Saved',
	baseUrl: 'https://saved/v1',
	apiKey: 'secret',
	models: ['manual'],
};
const target = { connectionId: record.id, model: 'manual' };

function seedNormalized(fixture: ReturnType<typeof setup>) {
	fixture.values.set(
		'test.app-ai',
		JSON.stringify({
			version: 1,
			connections: [record],
			selections: {
				chat: target,
				missing: { connectionId: 'unresolved:hosted', model: 'old' },
			},
		}),
	);
}

// ============================================================================
// Destination precedence and recovery
// ============================================================================

test('normalized split preserves IDs, credentials, order, scopes, and unresolved references', async () => {
	const fixture = setup();
	seedNormalized(fixture);
	const original = fixture.values.get('test.app-ai');
	await fixture.migrate();
	expect(fixture.connections().getAll()).toEqual([record]);
	expect(fixture.selections().get('chat')).toEqual(target);
	expect(fixture.selections().get('missing')).toEqual({
		connectionId: 'unresolved:hosted',
		model: 'old',
	});
	expect(fixture.values.get('test.app-ai')).toBe(original);
	expect(fixture.writes).toEqual([
		'test.app-ai-connections',
		'test.app-ai-selections',
	]);
});

test('each existing destination including an empty store wins over old settings', async () => {
	for (const existing of ['connections', 'selections'] as const) {
		const fixture = setup();
		seedNormalized(fixture);
		const raw = JSON.stringify({
			version: 1,
			[existing]: existing === 'connections' ? [] : {},
		});
		fixture.values.set(`test.app-ai-${existing}`, raw);
		await fixture.migrate();
		expect(fixture.values.get(`test.app-ai-${existing}`)).toBe(raw);
		expect(fixture.writes).toEqual([
			existing === 'connections'
				? 'test.app-ai-selections'
				: 'test.app-ai-connections',
		]);
	}
});

test('completed destinations do not parse malformed recovery bytes', async () => {
	const fixture = setup();
	await fixture.migrate();
	fixture.values.set('test.app-ai', 'broken secret recovery');
	fixture.values.set('test.inference-connections', 'broken secret legacy');
	fixture.writes.length = 0;
	await fixture.migrate();
	expect(fixture.writes).toEqual([]);
	expect(fixture.connections().getAll()).toEqual([]);
});

test('malformed destinations and combined sources fail before any split write', async () => {
	for (const [key, raw] of [
		['test.app-ai-connections', 'secret invalid JSON'],
		['test.app-ai-selections', JSON.stringify({ version: 2, selections: {} })],
		[
			'test.app-ai',
			JSON.stringify({
				version: 1,
				connections: [record],
				selections: { chat: { ...target, apiKey: 'secret' } },
			}),
		],
	]) {
		const fixture = setup();
		seedNormalized(fixture);
		fixture.values.set(key!, raw!);
		await expect(fixture.migrate()).rejects.toThrow('Invalid persisted');
		expect(fixture.writes).toEqual([]);
		expect(fixture.values.get(key!)).toBe(raw);
	}
});

test('failed first split write exposes no destination and restart recovers both', async () => {
	const fixture = setup();
	seedNormalized(fixture);
	fixture.failAt('test.app-ai-connections');
	await expect(fixture.migrate()).rejects.toThrow('write failed');
	expect(fixture.writes).toEqual([]);
	fixture.failAt();
	await fixture.migrate();
	expect(fixture.connections().getAll()[0]!.id).toBe(record.id);
	expect(fixture.selections().get('chat')).toEqual(target);
});

test('failed second split write preserves the first destination including later edits on restart', async () => {
	const fixture = setup();
	seedNormalized(fixture);
	fixture.failAt('test.app-ai-selections');
	await expect(fixture.migrate()).rejects.toThrow('write failed');
	const connections = fixture.connections();
	await connections.update(record.id, { name: 'Edited after interruption' });
	fixture.failAt();
	await fixture.migrate();
	expect(fixture.connections().getAll()[0]!.name).toBe(
		'Edited after interruption',
	);
	expect(fixture.selections().get('chat')).toEqual(target);
});

// ============================================================================
// Pre-ID normalization and document serialization
// ============================================================================

test('pre-ID normalization maps only unique URLs and retains old bytes', async () => {
	const fixture = setup();
	const raw = JSON.stringify([
		{ baseUrl: 'https://unique', apiKey: 'secret' },
		{ baseUrl: 'https://duplicate', apiKey: 'one' },
		{ baseUrl: 'https://duplicate', apiKey: 'two' },
	]);
	fixture.values.set('test.inference-connections', raw);
	fixture.values.set(
		'test.inference-targets',
		JSON.stringify(
			Object.fromEntries(
				[
					'https://unique',
					'https://duplicate',
					'https://missing',
					'hosted',
				].map((id) => [id, { connectionId: id, model: 'manual' }]),
			),
		),
	);
	await fixture.migrate();
	expect(fixture.selections().get('https://unique')!.connectionId).toBe(
		fixture.connections().getAll()[0]!.id,
	);
	for (const id of ['https://duplicate', 'https://missing', 'hosted'])
		expect(fixture.selections().get(id)!.connectionId).toBe(`unresolved:${id}`);
	expect(
		fixture
			.connections()
			.getAll()
			.map(({ apiKey }) => apiKey),
	).toEqual(['secret', 'one', 'two']);
	expect(fixture.values.get('test.inference-connections')).toBe(raw);
	expect(fixture.writes).toEqual([
		'test.app-ai',
		'test.app-ai-connections',
		'test.app-ai-selections',
	]);
});

test('failed normalization publishes no new IDs and restart uses one committed mapping', async () => {
	const fixture = setup();
	fixture.values.set(
		'test.inference-connections',
		JSON.stringify([{ baseUrl: 'https://legacy' }]),
	);
	fixture.values.set(
		'test.inference-targets',
		JSON.stringify({ chat: { connectionId: 'https://legacy', model: 'm' } }),
	);
	fixture.failAt('test.app-ai');
	await expect(fixture.migrate()).rejects.toThrow('write failed');
	expect(fixture.writes).toEqual([]);
	fixture.failAt('test.app-ai-connections');
	await expect(fixture.migrate()).rejects.toThrow('write failed');
	const committed = fixture.values.get('test.app-ai')!;
	const committedId = JSON.parse(committed).connections[0].id;
	fixture.failAt();
	await fixture.migrate();
	expect(fixture.values.get('test.app-ai')).toBe(committed);
	expect(fixture.connections().getAll()[0]!.id).toBe(committedId);
	expect(fixture.selections().get('chat')!.connectionId).toBe(committedId);
});

test('two queued document initializers re-read the committed mapping inside the lock', async () => {
	const fixture = setup();
	fixture.values.set(
		'test.inference-connections',
		JSON.stringify([{ baseUrl: 'https://legacy' }]),
	);
	fixture.values.set(
		'test.inference-targets',
		JSON.stringify({ chat: { connectionId: 'https://legacy', model: 'm' } }),
	);
	await Promise.all([fixture.migrate(), fixture.migrate()]);
	expect(fixture.writes).toEqual([
		'test.app-ai',
		'test.app-ai-connections',
		'test.app-ai-selections',
	]);
	expect(fixture.selections().get('chat')!.connectionId).toBe(
		fixture.connections().getAll()[0]!.id,
	);
});

test('connection-only import and full migration share a lock and preserve edits before selection opening', async () => {
	const fixture = setup();
	seedNormalized(fixture);
	await Promise.all([
		initializeAiConnections(fixture.options),
		fixture.migrate(),
	]);
	expect(fixture.writes).toEqual([
		'test.app-ai-connections',
		'test.app-ai-selections',
	]);
	fixture.connections().update(record.id, { name: 'Edited' });
	await fixture.migrate();
	expect(fixture.connections().getAll()[0]!.name).toBe('Edited');
	expect(fixture.selections().get('chat')).toEqual(target);
});

test('connection-only import never parses selections or assigns pre-ID identities', async () => {
	const fixture = setup();
	fixture.values.set(
		'test.app-ai',
		JSON.stringify({
			version: 1,
			connections: [record],
			selections: 'application-owned-invalid',
		}),
	);
	await initializeAiConnections(fixture.options);
	expect(fixture.connections().getAll()).toEqual([record]);
	expect(fixture.values.has('test.app-ai-selections')).toBe(false);
	await expect(fixture.migrate()).rejects.toThrow(
		'Invalid persisted inference selections',
	);
	const legacy = setup();
	legacy.values.set(
		'test.inference-connections',
		JSON.stringify([{ baseUrl: 'https://legacy' }]),
	);
	await expect(initializeAiConnections(legacy.options)).rejects.toThrow(
		'Initialize legacy AI settings',
	);
	expect(legacy.writes).toEqual([]);
});

test('malformed legacy records fail before normalized IDs are committed', async () => {
	for (const entry of [
		{ baseUrl: 'https://old', models: null },
		{ baseUrl: 'https://old', models: [123] },
		{ baseUrl: 'https://old', apiKey: 123 },
		{ baseUrl: 'https://old', unexpected: 'secret' },
	]) {
		const fixture = setup();
		fixture.values.set('test.inference-connections', JSON.stringify([entry]));
		await expect(fixture.migrate()).rejects.toThrow('Invalid persisted');
		expect(fixture.writes).toEqual([]);
	}
});
