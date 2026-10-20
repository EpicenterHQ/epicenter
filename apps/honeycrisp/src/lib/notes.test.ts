/**
 * Notes Tests
 *
 * Drives the notes state over this browser's local folder,
 * `openFolder({ tables: honeycrispTables })`, on an in-memory IndexedDB,
 * with the queries the open screens observe. A second handle of the same
 * profile stands in for another tab; a full disk is IndexedDB refusing to
 * store.
 *
 * Key behaviors:
 * - Opening and listing write nothing; a typed title or body saves once it
 *   is sent, and keeps every key Honeycrisp does not name
 * - Typing during a running save saves next; a read never replaces typing,
 *   and the save merges what another tab saved meanwhile
 * - A list action sets its field and keeps the fields another tab changed
 * - A failed save keeps the typing on screen and says so; Save again saves it
 * - A note that does not read as one is listed for repair, opens as text,
 *   saves as typed, and opens as a note once repaired
 * - A note open as its file takes text edits, merged by line with another
 *   tab's change, and refuses row edits meanwhile
 * - Create opens the new note in the folder shown; deleting a folder moves
 *   its notes out first, and refuses while a note cannot say its folder
 * - Delete sends what is typed first, then deletes the file
 * - Close sends typing still waiting and refuses input from then on
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import type { NotesFixture } from './local.test-support.ts';

const { openNotes, quiet, until, cached, rows, noteText, folderText } =
	await import('./local.test-support.ts');
const { foldersOf, repairsOf } = await import('./notes.svelte.ts');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const A = 'notes/a.md';

/** A fresh profile holding `files`, its notes loaded and observed as the screens do. */
async function setup(files: Record<string, string> = { [A]: noteText() }) {
	const fixture = await openNotes();
	cleanup.push(() => fixture.close());
	for (const [path, text] of Object.entries(files))
		await fixture.write(path, text);
	await fixture.notes.load();
	fixture.observe();
	await quiet(fixture.notes);
	return fixture;
}

/** Note `id` as another tab reads it now; it must be there. */
async function noteIn(
	tab: Awaited<ReturnType<NotesFixture['otherTab']>>,
	id: string,
) {
	const row = expectOk(await tab.tables.notes.get(id));
	if (row === undefined) throw new Error(`No note ${id}`);
	return row;
}

/** The folder the cache holds for `id`. */
function folderEntry(notes: NotesFixture['notes'], id: string) {
	const found = foldersOf(
		notes.queryClient.getQueryData(notes.rowsQuery('folders').queryKey) ?? [],
	).find((folder) => folder.id === id);
	if (found === undefined) throw new Error(`No folder ${id}`);
	return found;
}

test('opening a note writes nothing; a title and body save once sent, keeping keys Honeycrisp does not name', async () => {
	const { notes, saves, text } = await setup();
	notes.open(A);
	const note = notes.noteBody(A);
	expect(note.row?.fields.title).toBe('A');
	await quiet(notes);
	expect(saves(A)).toBe(0);

	expect(notes.editTitle(A, 'Renamed')).toBeUndefined();
	expect(note.edit('Body, edited.\n')).toBe(true);
	// Shown at once, before any save.
	expect(note.row?.fields.title).toBe('Renamed');
	expect(note.row?.body).toBe('Body, edited.\n');
	expect(notes.isWriting(A)).toBe(true);
	await notes.saveRow(A);
	await quiet(notes);

	expect(saves(A)).toBe(1);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('title: "Renamed"');
	expect(saved).toContain('Body, edited.');
	expect(saved).toMatch(/^owner:\n {2}name: one\n {2}tags: \[ ?two ?\]$/m);
	expect(cached(notes, 'a').fields.title).toBe('Renamed');
	expect(notes.isWriting(A)).toBe(false);
});

test('a body typed while its save runs is saved next, from the body that save sent', async () => {
	const { notes, text } = await setup();
	const note = notes.noteBody(A);
	note.edit('one\n');
	const first = notes.saveRow(A);
	note.edit('one two\n');
	await first;
	await notes.saveRow(A);
	await quiet(notes);
	expect(await text(A)).toContain('---\none two\n');
	expect(note.row?.body).toBe('one two\n');
});

test('a read that lands while a body is held does not replace it, and the save merges what it brought', async () => {
	const { notes, otherTab, text } = await setup({
		[A]: noteText({ body: 'one\n\ntwo\n' }),
	});
	const note = notes.noteBody(A);
	note.edit('one!\n\ntwo\n');

	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(await tab.tables.notes.set('a', theirs, { body: 'one\n\ntwo?\n' }));
	await until(() => rows(notes)[0]?.body === 'one\n\ntwo?\n', 'their save');
	// The cache holds their body; the screen still holds the typing.
	expect(note.row?.body).toBe('one!\n\ntwo\n');

	await notes.saveRow(A);
	await quiet(notes);
	expect(await text(A)).toContain('one!\n\ntwo?\n');
	expect(note.row?.body).toBe('one!\n\ntwo?\n');
});

test('a list action sets its field at once and keeps the fields another tab changed', async () => {
	const { notes, otherTab, text } = await setup();
	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(
		await tab.tables.notes.set('a', theirs, { fields: { title: 'Theirs' } }),
	);
	// The page still holds the title before their save.
	expect(notes.patchNote(A, { pinned: true })).toBeUndefined();
	await until(() => !notes.isWriting(A), 'the pin to save');
	await quiet(notes);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('pinned: true');
	expect(saved).toContain('title: "Theirs"');
	expect(cached(notes, 'a').fields).toMatchObject({
		pinned: true,
		title: 'Theirs',
	});
});

test('a save that fails keeps the typing on screen and says so; Save again saves it', async () => {
	const { notes, failSaves, text } = await setup();
	const note = notes.noteBody(A);
	failSaves();
	note.edit('kept\n');
	await notes.saveRow(A);
	expect(notes.isUnsaved(A)).toBe(true);
	expect(note.row?.body).toBe('kept\n');
	expect(notes.saves.label).toBe('Not saved');
	expect(notes.saves.detail).toContain('QuotaExceededError');
	expect(await text(A)).toContain('Body.');

	failSaves(false);
	await notes.saveRow(A);
	await quiet(notes);
	expect(notes.isUnsaved(A)).toBe(false);
	expect(await text(A)).toContain('---\nkept\n');
	expect(notes.saves.label).toBe('Saved on this device');
});

test('a change another tab saved shows in the lists and the open note', async () => {
	const { notes, otherTab } = await setup();
	notes.open(A);
	const note = notes.noteBody(A);
	const tab = await otherTab();
	expectOk(
		await tab.tables.notes.set('b', null, {
			fields: {
				folderId: null,
				title: 'B',
				pinned: false,
				createdAt: '2026-10-02T00:00:00.000Z',
				deletedAt: null,
			},
			body: '',
		}),
	);
	const theirs = await noteIn(tab, 'a');
	expectOk(await tab.tables.notes.set('a', theirs, { body: 'theirs\n' }));
	await until(
		() => rows(notes).length === 2 && note.row?.body === 'theirs\n',
		'their saves',
	);
});

test('a note whose text is not a note is listed for repair, opens as text, saves as typed, and opens as a note once repaired', async () => {
	const broken = noteText().replace('pinned: false', 'pinned: maybe');
	const { notes, observe, text, saves } = await setup({ [A]: broken });
	expect(repairsOf(rows(notes))).toEqual([
		{ path: A, message: expect.stringContaining('boolean') },
	]);
	notes.open(A);
	expect(notes.selected?.as).toBe('text');
	observe(A);
	await quiet(notes);
	expect(saves(A)).toBe(0);
	// A row edit is refused while the file does not read as a note.
	expect(notes.patchNote(A, { pinned: true })).toBeDefined();

	expect(notes.editText(A, noteText())).toBe(true);
	expect(notes.typedText(A)).toBe(noteText());
	await notes.saveText(A);
	await quiet(notes);
	expect(await text(A)).toBe(noteText());
	expect(notes.typedText(A)).toBeUndefined();
	expect(repairsOf(rows(notes))).toEqual([]);
	notes.open(A, 'note');
	expect(notes.noteBody(A).row?.fields.pinned).toBe(false);
});

test('a note open as its file takes text edits merged by line with another tab, and refuses row edits meanwhile', async () => {
	const { notes, observe, otherTab, text } = await setup({
		[A]: noteText({ body: 'one\n\ntwo\n' }),
	});
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	expect(notes.patchNote(A, { pinned: true })).toContain('open as text');
	expect(notes.editTitle(A, 'No')).toContain('open as text');

	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(await tab.tables.notes.set('a', theirs, { body: 'one\n\ntwo?\n' }));
	const typed = noteText({ title: 'Mine', body: 'one!\n\ntwo\n' });
	expect(notes.editText(A, typed)).toBe(true);
	await notes.saveText(A);
	await quiet(notes);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('title: "Mine"');
	expect(saved).toContain('one!\n\ntwo?\n');
	expect(cached(notes, 'a').fields.title).toBe('Mine');
});

test('a new note is created in the folder shown and opened', async () => {
	const { notes, text } = await setup({
		'folders/work.md': folderText('Work'),
	});
	notes.showFolder('work');
	expect(await notes.createNote()).toBeUndefined();
	const opened = notes.selected;
	if (opened === undefined) throw new Error('The new note did not open');
	expect(opened.as).toBe('note');
	const saved = (await text(opened.path)) ?? '';
	expect(saved).toContain('folderId: work');
	expect(saved).toContain('pinned: false');
});

test('deleting a folder moves its notes out first, then deletes its file', async () => {
	const { notes, text } = await setup({
		'folders/work.md': folderText('Work'),
		[A]: noteText({ folderId: 'work' }),
		'notes/b.md': noteText({ title: 'B' }),
	});
	notes.showFolder('work');
	expect(await notes.deleteFolder(folderEntry(notes, 'work'))).toBeUndefined();
	await quiet(notes);
	expect(await text('folders/work.md')).toBeUndefined();
	expect(await text(A)).toContain('folderId: null');
	expect(await text(A)).toContain('owner:');
	expect(notes.view.folderId).toBeNull();
});

test('a folder is not deleted while a note cannot say which folder it is in', async () => {
	const { notes, text } = await setup({
		'folders/work.md': folderText('Work'),
		[A]: noteText({ folderId: 'work' }),
		'notes/broken.md': 'no frontmatter\n',
	});
	expect(await notes.deleteFolder(folderEntry(notes, 'work'))).toContain(
		'broken.md',
	);
	expect(await text('folders/work.md')).toBe(folderText('Work'));
	expect(await text(A)).toContain('folderId: work');
});

test("a folder's name is a set of its row, saved at once", async () => {
	const { notes, text } = await setup({
		'folders/work.md': '---\nname: Work\nicon: null\ncolor: red\n---\n',
	});
	expect(
		notes.patchFolder('folders/work.md', { name: 'Play' }),
	).toBeUndefined();
	await until(() => !notes.isWriting('folders/work.md'), 'the name to save');
	expect(await text('folders/work.md')).toBe(
		'---\nname: Play\nicon: null\ncolor: red\n---\n',
	);
});

test('a delete sends what is typed first, then deletes the note', async () => {
	const { notes, text } = await setup();
	notes.open(A);
	notes.noteBody(A).edit('last words\n');
	const deletion = expectOk(await notes.deletionFor(A));
	expect(deletion.title).toBe('A');
	expect(await notes.delete(deletion)).toBeUndefined();
	await quiet(notes);
	expect(await text(A)).toBeUndefined();
	expect(notes.selected).toBeUndefined();
	expect(rows(notes)).toEqual([]);
});

test('a new file is made where none is, and a name some disk reads as another file is refused', async () => {
	const { notes, observe, text } = await setup();
	observe();
	expect(await notes.createFile('', 'con.txt')).toContain('device');
	expect(await notes.createFile('', 'draft.')).toContain('dot or a space');
	expect(await notes.createFile('notes', 'a.md')).toContain('already exists');
	expect(await notes.createFile('', '.gitignore')).toBeUndefined();
	expect(await text('.gitignore')).toBe('');
	expect(notes.selected).toEqual({
		path: '.gitignore',
		as: 'text',
		id: expect.any(Number),
	});
});

test('a lone surrogate typed in Source or the title is saved as U+FFFD', async () => {
	const { notes, text } = await setup();
	expect(notes.editBody(A, 'half \uD800\n')).toBeUndefined();
	expect(notes.editTitle(A, 'T\uDC00')).toBeUndefined();
	await notes.saveRow(A);
	await quiet(notes);
	expect(notes.isUnsaved(A)).toBe(false);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('half �\n');
	expect(saved).toContain('title: "T\uFFFD"');
});

test('close sends typing still waiting, and takes no input from then on', async () => {
	const { notes, local, text } = await setup();
	const note = notes.noteBody(A);
	note.edit('typed before close\n');
	notes.stop();
	expect(await local.close()).toEqual([]);
	expect(await text(A)).toContain('---\ntyped before close\n');
	expect(notes.fenced).toBe(true);
	expect(note.edit('late\n')).toBe(false);
	expect(await notes.createNote()).toContain('closing');
});

test('closing after a failed file save returns the exact text for recovery', async () => {
	const { notes, local, observe, failSaves, text } = await setup();
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	const changed = noteText({ title: 'Keep this draft' });
	expect(notes.editText(A, changed)).toBe(true);
	failSaves();
	const unsaved = await local.close();
	expect(unsaved).toMatchObject([
		{ path: A, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
	expect(await text(A)).not.toBe(changed);
});

test('a failed file edit stays visible and blocks list actions after selecting another note', async () => {
	const { notes, observe, failSaves } = await setup({
		[A]: noteText(),
		'notes/b.md': noteText({ title: 'B' }),
	});
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	const changed = noteText({ body: 'Keep this unfinished file\n' });
	notes.editText(A, changed);
	failSaves();
	await notes.saveText(A);
	notes.open('notes/b.md');
	expect(notes.patchNote(A, { pinned: true })).toContain('open as text');
	notes.open(A);
	expect(notes.selected?.as).toBe('text');
	expect(notes.typedText(A)).toBe(changed);
	failSaves(false);
	await notes.saveText(A);
	expect(notes.patchNote(A, { pinned: true })).toContain('open as text');
	notes.open(A, 'note');
	expect(notes.patchNote(A, { pinned: true })).toBeUndefined();
});

test('reading a file never sends pending body changes', async () => {
	const { notes, saves, text } = await setup();
	notes.editBody(A, 'Unsent body\n');
	const read = await notes.textQuery(A).queryFn();
	expect(read.kind).toBe('text');
	expect(saves(A)).toBe(0);
	expect(await text(A)).toContain('Body.');
	expect(notes.noteBody(A).row?.body).toBe('Unsent body\n');
});

test('a folder rename reports its held text rather than claiming the app is closing', async () => {
	const path = 'folders/f.md';
	const source = folderText('First');
	const { notes, observe, failSaves } = await setup({
		[A]: noteText(),
		[path]: source,
	});
	notes.open(path, 'text');
	observe(path);
	await quiet(notes);
	notes.editText(path, source.replace('First', 'Keep this name'));
	failSaves();
	await notes.saveText(path);
	notes.open(A);
	expect(notes.patchFolder(path, { name: 'Other name' })).toContain(
		'open as text',
	);
	expect(notes.typedText(path)).toContain('Keep this name');
});
