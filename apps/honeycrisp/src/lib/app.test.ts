/**
 * Editor derivations follow the App lifetime: ordinary close flushes the final
 * title, while retirement cancels queued work and rejects stale callbacks.
 */
import { expect, mock, test } from 'bun:test';
import type { ReactiveData } from '@epicenter/svelte';
import type { HoneycrispData, NoteId } from './data.js';

Reflect.set(
	globalThis,
	'$derived',
	Object.assign(<T>(value: T) => value, { by: <T>(read: () => T) => read() }),
);
mock.module('@epicenter/svelte', () => ({ fromSubscription: mock() }));
mock.module('$lib/data', () => ({ deleteHoneycrispFolder: mock() }));
mock.module('./navigation.svelte.js', () => ({
	navigation: { isDeletedView: false, folderId: null, query: '' },
}));
mock.module('./editor/node-text.js', () => ({
	noteTitle: (content: { title: string }) => content.title,
	notePreview: mock(),
}));
const { createHoneycrisp } = await import('./app.svelte.js');

function setup() {
	const lifetime = new AbortController();
	const content = { title: 'Final IME edit' };
	let changed = () => {};
	const update = mock(
		(_id: string, _fields: { title: string; updatedAt: string }) => {
			lifetime.signal.throwIfAborted();
			return { data: undefined, error: null };
		},
	);
	const stop = mock();
	const data = {
		signal: lifetime.signal,
		tables: {
			folders: { rows: [] },
			notes: {
				rows: [],
				get: () => ({ content }),
				update,
				watch: (_content: unknown, callback: () => void) => {
					changed = callback;
					return stop;
				},
			},
		},
	} as unknown as ReactiveData<HoneycrispData>;
	const app = createHoneycrisp({ data });
	const editor = app.tables.notes.openContent('note-1' as NoteId)!;
	return { editor, update, stop, lifetime, changed: () => changed() };
}

test('closing an editor flushes its queued derived title exactly once', async () => {
	const { editor, update, stop, lifetime, changed } = setup();
	changed();
	expect(update).not.toHaveBeenCalled();
	editor.close();
	expect(stop).toHaveBeenCalledTimes(1);
	expect(update).toHaveBeenCalledTimes(1);
	expect(update.mock.calls[0]).toEqual([
		'note-1',
		{ title: 'Final IME edit', updatedAt: expect.any(String) },
	]);
	// The App ends after ordinary UI cleanup; that cannot close this editor again.
	lifetime.abort();
	editor.close();
	changed();
	await Bun.sleep(5);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(update).toHaveBeenCalledTimes(1);
});

test.each([
	'immediate',
	'delayed',
] as const)('App retirement cancels the queued title with %s UI cleanup', async (cleanup) => {
	const { editor, update, stop, lifetime, changed } = setup();
	changed();
	lifetime.abort();
	expect(stop).toHaveBeenCalledTimes(1);
	// A watcher already copied for delivery must not recreate the cancelled timer.
	changed();
	if (cleanup === 'delayed') await Bun.sleep(5);
	expect(() => editor.close()).not.toThrow();
	await Bun.sleep(5);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(update).not.toHaveBeenCalled();
});
