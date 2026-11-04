/**
 * Model choice tests, over a place in memory.
 *
 * Key behaviors:
 * - A saved choice is answered as saved, detached from the caller's object,
 *   and keeps an endpoint that is gone; a job none was saved for answers
 *   the app's default
 * - A failed save changes nothing and tells no one
 * - A change made elsewhere is read again and told; disposal stops that
 * - Saved choices that do not read leave only the defaults, and say why
 */
import { expect, test } from 'bun:test';
import {
	type ChoicesPlace,
	createModelChoices,
	type SavedChoices,
} from './choices.js';

function memoryPlace(initial: SavedChoices = {}) {
	let saved: SavedChoices = initial;
	let fail = false;
	let unreadable = false;
	const listeners = new Set<() => void>();
	const place: ChoicesPlace = {
		async read() {
			if (unreadable) throw new Error('models.md does not read.');
			return saved;
		},
		async save(job, choice) {
			if (fail) throw new Error('Storage write failed.');
			saved = { ...saved, [job]: choice };
			return saved;
		},
		watch(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		place,
		listeners,
		failWrites: () => {
			fail = true;
		},
		breakReads: () => {
			unreadable = true;
		},
		changeElsewhere(next: SavedChoices) {
			saved = next;
			for (const listener of listeners) listener();
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a saved choice is answered as saved, detached, and a job none was saved for answers the default', async () => {
	const memory = memoryPlace();
	const choices = createModelChoices<'chat' | 'transcribe'>(memory.place, {
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await choices.ready;
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'default' });
	expect(choices.get('transcribe')).toBeNull();

	const target = { endpoint: 'gone-endpoint', model: 'manual' };
	await choices.set('transcribe', target);
	target.model = 'changed';
	choices.get('transcribe')!.endpoint = 'changed';
	expect(choices.get('transcribe')).toEqual({
		endpoint: 'gone-endpoint',
		model: 'manual',
	});
	const reopened = createModelChoices(memory.place);
	await reopened.ready;
	expect(reopened.get('transcribe')).toEqual({
		endpoint: 'gone-endpoint',
		model: 'manual',
	});
});

test('a failed save changes nothing and tells no one', async () => {
	const memory = memoryPlace({ chat: { endpoint: 'one', model: 'm' } });
	const choices = createModelChoices(memory.place);
	await choices.ready;
	let changes = 0;
	choices.subscribe(() => changes++);
	memory.failWrites();
	await expect(
		choices.set('chat', { endpoint: 'two', model: 'm' }),
	).rejects.toThrow('write failed');
	expect(choices.get('chat')?.endpoint).toBe('one');
	expect(changes).toBe(0);
});

test('a change made elsewhere is read again and told, until disposal', async () => {
	const memory = memoryPlace();
	const choices = createModelChoices(memory.place);
	await choices.ready;
	let changes = 0;
	choices.subscribe(() => changes++);
	memory.changeElsewhere({ chat: { endpoint: 'two', model: 'm' } });
	await settle();
	expect(choices.get('chat')?.endpoint).toBe('two');
	expect(changes).toBe(1);

	const { get, set, subscribe } = choices;
	choices[Symbol.dispose]();
	choices[Symbol.dispose]();
	expect(memory.listeners.size).toBe(0);
	expect(() => get('chat')).toThrow('disposed');
	expect(() => set('chat', { endpoint: 'x', model: 'm' })).toThrow('disposed');
	expect(() => subscribe(() => {})).toThrow('disposed');
});

test('saved choices that do not read leave the defaults, and say why', async () => {
	const memory = memoryPlace();
	memory.breakReads();
	const choices = createModelChoices(memory.place, {
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await choices.ready;
	expect(choices.problem()).toBe('models.md does not read.');
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'default' });
});

test('a choice with anything beside its endpoint and model is refused', async () => {
	const choices = createModelChoices(memoryPlace().place);
	expect(() =>
		choices.set('chat', {
			endpoint: 'one',
			model: 'm',
			apiKey: 'secret',
		} as never),
	).toThrow('Invalid persisted model choices.');
});
