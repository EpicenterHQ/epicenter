import { expect, mock, test } from 'bun:test';
import type { ReactiveData } from '@epicenter/svelte';
import type { HoneycrispData, NoteId } from './data';

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
const { createHoneycrisp } = await import('./app.svelte');

test('closing an editor flushes its queued derived title exactly once', async () => {
	const content = { title: 'Final IME edit' };
	let changed = () => {};
	const update = mock(
		(_id: string, _fields: { title: string; updatedAt: string }) => ({
			data: undefined,
			error: null,
		}),
	);
	const stop = mock();
	const data = {
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
	changed();
	expect(update).not.toHaveBeenCalled();
	editor.close();
	expect(stop).toHaveBeenCalledTimes(1);
	expect(update).toHaveBeenCalledTimes(1);
	expect(update.mock.calls[0]).toEqual([
		'note-1',
		{ title: 'Final IME edit', updatedAt: expect.any(String) },
	]);
	await Bun.sleep(5);
	expect(update).toHaveBeenCalledTimes(1);
});
