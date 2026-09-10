/**
 * Application inference selection tests.
 * Verifies detached exact targets, failed writes, strict persisted validation,
 * independent observation, and refusal through retained methods after disposal.
 */
import { expect, test } from 'bun:test';
import { createInferenceSelections } from './inference-selections.js';

function setup() {
	const values = new Map<string, string>();
	const observers = new Set<() => void>();
	let fail = false;
	return {
		values,
		observers,
		failWrites() {
			fail = true;
		},
		open() {
			return createInferenceSelections({
				storageKey: 'test',
				storage: {
					getItem(key) {
						return values.get(key) ?? null;
					},
					setItem(key, value) {
						if (fail) throw new Error('Storage write failed.');
						values.set(key, value);
					},
				},
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

test('saved scopes preserve exact identities and models across reload without retaining caller objects', () => {
	const fixture = setup();
	const selections = fixture.open();
	const target = {
		connectionId: 'unresolved:https://missing',
		model: 'manual',
	};
	selections.set('chat', target);
	target.model = 'changed';
	selections.get('chat')!.connectionId = 'changed';
	expect(selections.get('missing')).toBeNull();
	expect(selections.get('toString')).toBeNull();
	selections.set('__proto__', { connectionId: 'custom', model: 'm' });
	expect(fixture.open().get('chat')).toEqual({
		connectionId: 'unresolved:https://missing',
		model: 'manual',
	});
	expect(fixture.open().get('__proto__')).toEqual({
		connectionId: 'custom',
		model: 'm',
	});
	expect([...fixture.values.keys()]).toEqual(['test.app-ai-selections']);
});

test('failed selection persistence leaves the saved target visible and sends no notification', () => {
	const fixture = setup();
	const selections = fixture.open();
	selections.set('chat', { connectionId: 'one', model: 'm' });
	let changes = 0;
	selections.onChange(() => changes++);
	fixture.failWrites();
	expect(() =>
		selections.set('chat', { connectionId: 'two', model: 'm' }),
	).toThrow('write failed');
	expect(selections.get('chat')!.connectionId).toBe('one');
	expect(changes).toBe(0);
});

test('external updates use only the selection destination and disposal releases observation', () => {
	const fixture = setup();
	const selections = fixture.open();
	let changes = 0;
	selections.onChange(() => changes++);
	selections.set('chat', { connectionId: 'one', model: 'm' });
	fixture.values.set('test.app-ai', 'malformed old settings');
	fixture.externalChange();
	expect(changes).toBe(1);
	fixture.values.set(
		'test.app-ai-selections',
		JSON.stringify({
			version: 1,
			selections: { chat: { connectionId: 'two', model: 'm' } },
		}),
	);
	fixture.externalChange();
	expect(selections.get('chat')!.connectionId).toBe('two');
	expect(changes).toBe(2);
	const { get, set, onChange } = selections;
	selections[Symbol.dispose]();
	selections[Symbol.dispose]();
	expect(fixture.observers.size).toBe(0);
	expect(() => get('chat')).toThrow('disposed');
	expect(() => set('chat', { connectionId: 'x', model: 'm' })).toThrow(
		'disposed',
	);
	expect(() => onChange(() => {})).toThrow('disposed');
});

test('malformed choices and unsupported versions fail without exposing or changing saved bytes', () => {
	for (const raw of [
		'secret invalid JSON',
		JSON.stringify({ version: 2, selections: {} }),
		JSON.stringify({
			version: 1,
			selections: {
				chat: { connectionId: 'one', model: 'm', apiKey: 'secret' },
			},
		}),
	]) {
		const fixture = setup();
		fixture.values.set('test.app-ai-selections', raw);
		expect(() => fixture.open()).toThrow(
			'Invalid persisted inference selections.',
		);
		expect(fixture.values.get('test.app-ai-selections')).toBe(raw);
	}
});

test('opening before legacy conversion cannot hide saved scopes behind a new destination', () => {
	for (const key of [
		'test.app-ai',
		'test.inference-targets',
		'test.inference-connections',
	]) {
		const fixture = setup();
		fixture.values.set(key, 'legacy recovery bytes');
		expect(() => fixture.open()).toThrow('Initialize legacy AI settings');
		expect(fixture.values.has('test.app-ai-selections')).toBe(false);
		expect(fixture.observers.size).toBe(0);
		fixture.values.set(
			'test.app-ai-selections',
			JSON.stringify({ version: 1, selections: {} }),
		);
		expect(fixture.open().get('chat')).toBeNull();
	}
});
