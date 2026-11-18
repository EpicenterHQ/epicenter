/**
 * One note as an editor, over a note and a save the test decides.
 *
 * Key behaviors:
 * - A save that fails keeps what was typed and says why; Try again saves it
 * - When the note changed elsewhere, the newer note shows under what was
 *   typed, nothing more saves on its own, and keeping mine writes it over
 * - Discard drops what was typed and shows the note
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { Ok, type Result } from 'wellcrafted/result';
import { failed } from './files/files.js';
import type { NOTES } from './format/folder.js';
import { NoteError, type NotePatch, type NoteWriteError } from './notes.js';

const { editNote, unsaved } = await import('./note-editor.svelte.js');

type Recording = typeof NOTES.recordings;

/** An editor over `note`, whose saves answer `answer` and are kept in `saves`. */
function open(note: Record<string, unknown>) {
	const at = {
		note,
		answer: Ok(undefined) as Result<undefined, NoteWriteError>,
	};
	const saves: NotePatch<Recording>[] = [];
	const editor = editNote<Recording>({
		fieldNames: ['title', 'recordedAt', 'durationMs'],
		get: () => at.note,
		save: async (changes) => {
			saves.push(changes);
			return at.answer;
		},
	});
	return { at, saves, editor };
}

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

const STANDUP = {
	title: 'Standup',
	recordedAt: '2026-11-01T09:00:00.000Z',
	body: 'notes\n',
};

test('a save that fails keeps what was typed and says why, and Try again saves it', async () => {
	const { at, saves, editor } = open(STANDUP);
	at.answer = failed('The disk is full');

	editor.fields.title = 'Mine';
	await until(() => editor.problem() !== null);

	expect(editor.problem()?.message).toBe('The disk is full');
	expect(editor.fields.title).toBe('Mine');
	expect(unsaved()).toBe(1);

	at.answer = Ok(undefined);
	at.note = { ...STANDUP, title: 'Mine' };
	editor.retry();
	await until(() => unsaved() === 0);
	expect(editor.problem()).toBeNull();
	expect(saves).toEqual([{ title: 'Mine' }, { title: 'Mine' }]);
});

test('a note changed elsewhere shows under the typing, saves nothing more on its own, and keeping mine writes it over', async () => {
	const { at, saves, editor } = open(STANDUP);
	at.answer = NoteError.Changed({ path: 'recordings/standup.md' });

	editor.fields.title = 'Mine';
	await until(() => editor.problem()?.name === 'Changed');
	// The refused save read the folder again, which shows the newer note.
	at.note = { ...STANDUP, title: 'Theirs', body: 'their notes\n' };

	expect(editor.fields.title).toBe('Mine');
	expect(editor.fields.body).toBe('their notes\n');
	editor.fields.title = 'Mine, still';
	await Bun.sleep(400);
	expect(saves).toHaveLength(1);

	at.answer = Ok(undefined);
	editor.retry();
	await until(() => unsaved() === 0);
	expect(saves.at(-1)).toEqual({ title: 'Mine, still' });
});

test('Discard drops what was typed and shows the note', async () => {
	const { at, editor } = open(STANDUP);
	at.answer = failed('The disk is full');
	editor.fields.title = 'Mine';
	await until(() => editor.problem() !== null);

	editor.discard();

	expect(editor.fields.title).toBe('Standup');
	expect(editor.problem()).toBeNull();
	expect(unsaved()).toBe(0);
});
