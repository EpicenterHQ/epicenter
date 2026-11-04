/**
 * Model choice tests.
 * Verifies detached exact targets, failed writes, strict persisted validation,
 * independent observation, and refusal through retained methods after disposal.
 */
import { expect, test } from 'bun:test';
import { createModelChoices } from './choices.js';

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
			return createModelChoices({
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
		endpoint: 'unresolved:https://missing',
		model: 'manual',
	};
	selections.set('chat', target);
	target.model = 'changed';
	selections.get('chat')!.endpoint = 'changed';
	expect(selections.get('missing')).toBeNull();
	expect(selections.get('toString')).toBeNull();
	selections.set('__proto__', { endpoint: 'custom', model: 'm' });
	expect(fixture.open().get('chat')).toEqual({
		endpoint: 'unresolved:https://missing',
		model: 'manual',
	});
	expect(fixture.open().get('__proto__')).toEqual({
		endpoint: 'custom',
		model: 'm',
	});
	expect([...fixture.values.keys()]).toEqual(['test.model-choices']);
});

test('failed selection persistence leaves the saved target visible and sends no notification', () => {
	const fixture = setup();
	const selections = fixture.open();
	selections.set('chat', { endpoint: 'one', model: 'm' });
	let changes = 0;
	selections.subscribe(() => changes++);
	fixture.failWrites();
	expect(() => selections.set('chat', { endpoint: 'two', model: 'm' })).toThrow(
		'write failed',
	);
	expect(selections.get('chat')!.endpoint).toBe('one');
	expect(changes).toBe(0);
});

test('external updates use only the selection destination and disposal releases observation', () => {
	const fixture = setup();
	const selections = fixture.open();
	let changes = 0;
	selections.subscribe(() => changes++);
	selections.set('chat', { endpoint: 'one', model: 'm' });
	fixture.values.set('test.app-ai', 'malformed old settings');
	fixture.externalChange();
	expect(changes).toBe(1);
	fixture.values.set(
		'test.model-choices',
		JSON.stringify({
			version: 1,
			choices: { chat: { endpoint: 'two', model: 'm' } },
		}),
	);
	fixture.externalChange();
	expect(selections.get('chat')!.endpoint).toBe('two');
	expect(changes).toBe(2);
	const { get, set, subscribe } = selections;
	selections[Symbol.dispose]();
	selections[Symbol.dispose]();
	expect(fixture.observers.size).toBe(0);
	expect(() => get('chat')).toThrow('disposed');
	expect(() => set('chat', { endpoint: 'x', model: 'm' })).toThrow('disposed');
	expect(() => subscribe(() => {})).toThrow('disposed');
});

test('malformed choices and unsupported versions fail without exposing or changing saved bytes', () => {
	for (const raw of [
		'secret invalid JSON',
		JSON.stringify({ version: 2, choices: {} }),
		JSON.stringify({
			version: 1,
			choices: {
				chat: { endpoint: 'one', model: 'm', apiKey: 'secret' },
			},
		}),
	]) {
		const fixture = setup();
		fixture.values.set('test.model-choices', raw);
		expect(() => fixture.open()).toThrow('Invalid persisted model choices.');
		expect(fixture.values.get('test.model-choices')).toBe(raw);
	}
});
