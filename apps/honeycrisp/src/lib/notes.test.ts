/**
 * Editor derivations follow the App lifetime: ordinary close flushes the final
 * title, while retirement cancels queued work and rejects stale callbacks.
 * Domain commands preserve note defaults, selection changes, and folder reparenting.
 */
import { expect, mock, test } from 'bun:test';
import { openApp } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';
import type { ReactiveData } from '@epicenter/svelte';
import {
	deleteHoneycrispFolder,
	type HoneycrispData,
	honeycrispDefinition,
	type NoteId,
} from './data.js';

mock.module('@epicenter/svelte', () => ({ fromSubscription: mock() }));
const navigation = {
	folderId: null as string | null,
	selectNote: mock(),
	noteRemoved: mock(),
};
mock.module('./navigation.svelte.js', () => ({ navigation }));
mock.module('./editor/node-text.js', () => ({
	noteTitle: (content: { title: string }) => content.title,
	notePreview: mock(),
}));
const { openContent, createNote, deleteNote, permanentlyDeleteNote } =
	await import('./notes.js');

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
	const editor = openContent(data, 'note-1' as NoteId);
	if (!editor) throw new Error('Expected fixture note content');
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

test('note creation uses the displayed folder and deletion clears selection', async () => {
	const app = await openApp(honeycrispDefinition, {
		runtime: createMemoryRuntime(),
	});
	try {
		const folder = app.device.tables.folders.create({
			name: 'Work',
			icon: null,
		});
		navigation.folderId = folder.id;
		createNote(app.device);
		const note = app.device.tables.notes.rows[0];
		if (!note) throw new Error('Expected created note');
		expect(note.folderId).toBe(folder.id);
		expect(note.title).toBe('');
		expect(note.deletedAt).toBeNull();
		expect(navigation.selectNote).toHaveBeenLastCalledWith(note.id);
		deleteNote(app.device, note.id);
		expect(app.device.tables.notes.get(note.id)?.deletedAt).not.toBeNull();
		expect(navigation.noteRemoved).toHaveBeenLastCalledWith(note.id);
		permanentlyDeleteNote(app.device, note.id);
		expect(app.device.tables.notes.get(note.id)).toBeUndefined();
	} finally {
		navigation.folderId = null;
		await app.close();
	}
});

test('deleting a folder preserves its notes and removes their folder assignment', async () => {
	const app = await openApp(honeycrispDefinition, {
		runtime: createMemoryRuntime(),
	});
	try {
		const folder = app.device.tables.folders.create({
			name: 'Work',
			icon: null,
		});
		navigation.folderId = folder.id;
		createNote(app.device);
		const note = app.device.tables.notes.rows[0];
		if (!note) throw new Error('Expected created note');
		deleteHoneycrispFolder(app.device, folder.id);
		expect(app.device.tables.folders.get(folder.id)).toBeUndefined();
		expect(app.device.tables.notes.get(note.id)?.folderId).toBeNull();
		expect(app.device.tables.notes.get(note.id)?.deletedAt).toBeNull();
	} finally {
		navigation.folderId = null;
		await app.close();
	}
});
