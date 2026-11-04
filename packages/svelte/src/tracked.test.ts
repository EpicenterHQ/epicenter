/**
 * `trackReads`, the helper under every capability's Svelte adapter: a read
 * becomes a getter that subscribes only while an effect reads it, and the
 * rest is carried through as it is.
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import { flushSync } from 'svelte';
import { trackReads } from './tracked.js';

const { follow } = await import('./reactive.test-support.svelte.js');

/** A capability whose one value a test changes, with its listeners counted. */
function counter() {
	let value = 0;
	const listeners = new Set<() => void>();
	return {
		listeners,
		read: () => value,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		bump() {
			value++;
			for (const listener of listeners) listener();
		},
	};
}

test('a read tracks while an effect reads it, and lets go when the last reader stops', () => {
	const source = counter();
	const adapted = trackReads(source.subscribe, { value: source.read });
	expect(source.listeners.size).toBe(0);

	const followed = follow(() => adapted.value);
	flushSync();
	expect(source.listeners.size).toBe(1);
	source.bump();
	flushSync();
	expect(followed.values).toEqual([0, 1]);

	followed.stop();
	flushSync();
	expect(source.listeners.size).toBe(0);
});

test('a read outside an effect is a snapshot, and the rest is carried through with its getters', () => {
	const source = counter();
	let live = 'first';
	const rest = {
		act: () => 'acted',
		get live() {
			return live;
		},
	};
	const adapted = trackReads(source.subscribe, { value: source.read }, rest);
	source.bump();
	expect(adapted.value).toBe(1);
	expect(source.listeners.size).toBe(0);
	expect(adapted.act()).toBe('acted');
	live = 'second';
	expect(adapted.live).toBe('second');
});
