/**
 * One note as an editor, saving through the notes service over files in
 * memory that another program also writes.
 *
 * Key behaviors:
 * - A field is saved over the file as it is now: what another program
 *   wrote elsewhere in the note stays
 * - A body typed over a body changed on disk is refused, writes nothing,
 *   and saves nothing more on its own; keeping mine writes it over the
 *   newer body
 * - A save that fails keeps what was typed and says why; Try again saves it
 * - Discard drops what was typed and shows the note
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { decode, encode, type Files, failed } from './files/files.js';
import { memoryFiles } from './files/memory.js';
import type { NOTES } from './format/folder.js';
import { createNotes } from './notes.js';

const { editNote, unsaved } = await import('./note-editor.svelte.js');

type Recording = typeof NOTES.recordings;

const ID = '2026-11-01T09-00-00-000Z-standup1';
const PATH = `recordings/${ID}.md`;
const note = (title: string, body: string) =>
	`---\ntitle: "${title}"\nrecordedAt: "2026-11-01T09:00:00.000Z"\n---\n${body}`;
const shown = (title: string, body: string) => ({
	title,
	recordedAt: '2026-11-01T09:00:00.000Z',
	body,
});

/**
 * An editor over note `ID` in `files`, as the page shows it: `at.note` is
 * the note as last listed, which a test moves on as a re-read would.
 */
function open(files: Files) {
	const notes = createNotes(files);
	const at = { note: shown('Standup', 'notes\n') as Record<string, unknown> };
	let saves = 0;
	const editor = editNote<Recording>({
		fieldNames: ['title', 'recordedAt', 'durationMs'],
		get: () => at.note,
		save: (change) => {
			saves++;
			return notes.set({ collection: 'recordings', id: ID, ...change });
		},
	});
	return { at, editor, saves: () => saves };
}

const fileOf = async (files: Files) =>
	decode(expectOk(await files.read(PATH)) ?? new Uint8Array());

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

test('a title is saved over the file as it is now, keeping what another program wrote', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup', 'notes\n')) });
	const { editor } = open(files);
	expectOk(await files.write(PATH, encode(note('Standup', 'their notes\n'))));

	editor.fields.title = 'Mine';
	await until(() => unsaved() === 0);

	expect(editor.problem()).toBeNull();
	expect(await fileOf(files)).toBe(note('Mine', 'their notes\n'));
});

test('a body typed over a body changed on disk is refused, and keeping mine writes it over the newer body', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup', 'notes\n')) });
	const { at, editor, saves } = open(files);
	expectOk(await files.write(PATH, encode(note('Standup', 'their notes\n'))));

	editor.fields.body = 'my notes\n';
	await until(() => editor.problem()?.name === 'Changed');
	expect(await fileOf(files)).toBe(note('Standup', 'their notes\n'));
	// The refused save read the folder again, which shows the newer note.
	at.note = shown('Standup', 'their notes\n');
	expect(editor.fields.body).toBe('my notes\n');

	// Nothing more saves on its own.
	editor.fields.body = 'my notes, still\n';
	await Bun.sleep(400);
	expect(saves()).toBe(1);

	editor.retry();
	await until(() => unsaved() === 0);
	expect(editor.problem()).toBeNull();
	expect(await fileOf(files)).toBe(note('Standup', 'my notes, still\n'));
});

test('a save that fails keeps what was typed and says why, and Try again saves it', async () => {
	const inner = memoryFiles({ [PATH]: encode(note('Standup', 'notes\n')) });
	let full = true;
	const files: Files = {
		...inner,
		write: async (path, bytes) =>
			full ? failed('The disk is full') : inner.write(path, bytes),
	};
	const { editor } = open(files);

	editor.fields.title = 'Mine';
	await until(() => editor.problem() !== null);

	expect(editor.problem()?.message).toBe('The disk is full');
	expect(editor.fields.title).toBe('Mine');
	expect(unsaved()).toBe(1);

	full = false;
	editor.retry();
	await until(() => unsaved() === 0);
	expect(editor.problem()).toBeNull();
	expect(await fileOf(inner)).toBe(note('Mine', 'notes\n'));
});

test('Discard drops what was typed and shows the note', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup', 'notes\n')) });
	expectOk(await files.write(PATH, encode(note('Standup', 'theirs\n'))));
	const { editor } = open(files);
	editor.fields.body = 'mine\n';
	await until(() => editor.problem() !== null);

	editor.discard();

	expect(editor.fields.body).toBe('notes\n');
	expect(editor.problem()).toBeNull();
	expect(unsaved()).toBe(0);
});
