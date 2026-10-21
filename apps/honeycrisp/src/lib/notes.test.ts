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
 *   tab's change, and permits row patches meanwhile
 * - Create opens the new note in the folder shown; deleting a folder moves
 *   its notes out first, and refuses while a note cannot say its folder or
 *   before moving any note when it finds one in the folder it did not name
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
const { textRead } = await import('./file-reads.js');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const A = 'notes/a.md';

/**
 * Type `text` into `path` as an open file view does: through the folder's
 * edit of the file, whose document the lists already read.
 */
function typeInto(notes: NotesFixture['notes'], path: string, text: string) {
	return notes.folder.files.edit(path).replaceText(text);
}

/** Send what is typed into note `a` now, as leaving the note does. */
const saveA = ({ folder }: NotesFixture) =>
	folder.tables.notes.edit('a').save();

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
		notes.queryClient.getQueryData(notes.queries.rows('folders').queryKey) ??
			[],
	).find((folder) => folder.id === id);
	if (found === undefined) throw new Error(`No folder ${id}`);
	return found;
}

test('opening a note writes nothing; a title and body save once sent, keeping keys Honeycrisp does not name', async () => {
	const fixture = await setup();
	const { notes, saves, text } = fixture;
	notes.open(A);
	const note = notes.folder.tables.notes.edit('a');
	expect(note.getMarkdown()?.fields?.title).toBe('A');
	await quiet(notes);
	expect(saves(A)).toBe(0);

	expectOk(note.change({ fields: { title: 'Renamed' } }));
	expectOk(note.change({ body: 'Body, edited.\n' }));
	// Shown at once, before any save.
	expect(note.getMarkdown()?.fields?.title).toBe('Renamed');
	expect(note.getMarkdown()?.body).toBe('Body, edited.\n');
	expect(notes.isWriting(A)).toBe(true);
	await saveA(fixture);
	await quiet(notes);

	expect(saves(A)).toBe(1);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('title: "Renamed"');
	expect(saved).toContain('Body, edited.');
	expect(saved).toMatch(/^owner:\n {2}name: one\n {2}tags: \[ ?two ?\]$/m);
	expect(cached(notes, 'a').fields?.title).toBe('Renamed');
	expect(notes.isWriting(A)).toBe(false);
});

test('a body typed while its save runs is saved next, from the body that save sent', async () => {
	const fixture = await setup();
	const { notes, text } = fixture;
	const note = notes.folder.tables.notes.edit('a');
	note.change({ body: 'one\n' });
	const first = saveA(fixture);
	// The view shows what it typed before typing on.
	expect(note.getMarkdown()?.body).toBe('one\n');
	note.change({ body: 'one two\n' });
	await first;
	await saveA(fixture);
	await quiet(notes);
	expect(await text(A)).toContain('---\none two\n');
	expect(note.getMarkdown()?.body).toBe('one two\n');
});

test('a read that lands while a body is held does not replace it, and the save merges what it brought', async () => {
	const fixture = await setup({
		[A]: noteText({ body: 'one\n\ntwo\n' }),
	});
	const { notes, otherTab, text } = fixture;
	const note = notes.folder.tables.notes.edit('a');
	note.change({ body: 'one!\n\ntwo\n' });

	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(await tab.tables.notes.set('a', theirs, { body: 'one\n\ntwo?\n' }));
	await until(() => rows(notes)[0]?.body === 'one\n\ntwo?\n', 'their save');
	// The cache holds their body; the screen still holds the typing.
	expect(note.getMarkdown()?.body).toBe('one!\n\ntwo\n');

	await saveA(fixture);
	await quiet(notes);
	expect(await text(A)).toContain('one!\n\ntwo?\n');
	expect(note.getMarkdown()?.body).toBe('one!\n\ntwo?\n');
});

test('a list action sets its field at once and keeps the fields another tab changed', async () => {
	const { notes, otherTab, text } = await setup();
	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(
		await tab.tables.notes.set('a', theirs, { fields: { title: 'Theirs' } }),
	);
	// The list still shows the title before their save.
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
	const fixture = await setup();
	const { notes, failSaves, text } = fixture;
	const note = notes.folder.tables.notes.edit('a');
	failSaves();
	note.change({ body: 'kept\n' });
	await saveA(fixture);
	expect(notes.isUnsaved(A)).toBe(true);
	expect(note.getMarkdown()?.body).toBe('kept\n');
	expect(notes.saves.label).toBe('Not saved');
	expect(notes.saves.detail).toContain('QuotaExceededError');
	expect(await text(A)).toContain('Body.');

	failSaves(false);
	await fixture.folder.tables.notes.edit('a').save();
	await quiet(notes);
	expect(notes.isUnsaved(A)).toBe(false);
	expect(await text(A)).toContain('---\nkept\n');
	expect(notes.saves.label).toBe('Saved on this device');
});

test('a change another tab saved shows in the lists and the open note', async () => {
	const { notes, otherTab } = await setup();
	notes.open(A);
	const note = notes.folder.tables.notes.edit('a');
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
		() => rows(notes).length === 2 && note.getMarkdown()?.body === 'theirs\n',
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

	expectOk(typeInto(notes, A, noteText()));
	expect(notes.folder.files.edit(A).getPending()).toMatchObject({
		kind: 'text',
		text: noteText(),
	});
	await notes.folder.files.edit(A).save();
	await quiet(notes);
	expect(await text(A)).toBe(noteText());
	expect(notes.folder.files.edit(A).getPending()).toBeUndefined();
	expect(repairsOf(rows(notes))).toEqual([]);
	notes.open(A, 'note');
	expect(
		notes.folder.tables.notes.edit('a').getMarkdown()?.fields?.pinned,
	).toBe(false);
});

test('a note open as its file takes text edits merged by line with another tab, and permits row patches meanwhile', async () => {
	const { notes, observe, otherTab, text } = await setup({
		[A]: noteText({ body: 'one\n\ntwo\n' }),
	});
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	const note = notes.folder.tables.notes.edit('a');
	expectOk(note.change({ fields: { pinned: true } }));
	expect(note.getMarkdown()?.fields?.pinned).toBe(true);

	const tab = await otherTab();
	const theirs = await noteIn(tab, 'a');
	expectOk(await tab.tables.notes.set('a', theirs, { body: 'one\n\ntwo?\n' }));
	const typed = noteText({ title: 'Mine', body: 'one!\n\ntwo\n' });
	expectOk(typeInto(notes, A, typed));
	await notes.folder.files.edit(A).save();
	await quiet(notes);
	const saved = (await text(A)) ?? '';
	expect(saved).toContain('title: "Mine"');
	expect(saved).toContain('one!\n\ntwo?\n');
	expect(cached(notes, 'a').fields?.title).toBe('Mine');
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

test('a folder deletion keeps notes already moved when a later note cannot save', async () => {
	const { notes, failSaves, text } = await setup({
		'folders/work.md': folderText('Work'),
		[A]: noteText({ folderId: 'work' }),
		'notes/b.md': noteText({ title: 'B', folderId: 'work' }),
	});
	cleanup.push(
		notes.folder.onChange((change) => {
			if (change.origin === 'this-handle' && change.paths?.includes(A))
				failSaves();
		}),
	);

	expect(await notes.deleteFolder(folderEntry(notes, 'work'))).toContain(
		'QuotaExceededError',
	);
	expect(await text(A)).toContain('folderId: null');
	expect(await text('notes/b.md')).toContain('folderId: work');
	expect(await text('folders/work.md')).toBe(folderText('Work'));
});

test('a folder deletion that finds a note this page did not list moves nothing, saves what is typed, and succeeds again', async () => {
	// Not observed: another tab's save marks the rows stale without rereading
	// them, so the page still lists only `a`.
	const fixture = await openNotes();
	cleanup.push(() => fixture.close());
	const { notes, write, text } = fixture;
	await write('folders/work.md', folderText('Work'));
	await write(A, noteText({ folderId: 'work' }));
	await notes.load();
	await write('notes/b.md', noteText({ title: 'B', folderId: 'work' }));
	await quiet(notes);
	expect(rows(notes).map((note) => note.id)).toEqual(['a']);
	expectOk(
		notes.folder.tables.notes.edit('a').change({ body: 'Typed first\n' }),
	);

	const refused = await notes.deleteFolder(folderEntry(notes, 'work'));
	expect(refused).toContain('b.md');
	expect(refused).toContain('no note was moved');
	expect(await text(A)).toContain('folderId: work');
	expect(await text(A)).toContain('Typed first');
	expect(await text('notes/b.md')).toContain('folderId: work');
	expect(await text('folders/work.md')).toBe(folderText('Work'));
	// The page holds what the refused deletion read.
	expect(rows(notes).map((note) => note.id)).toEqual(['a', 'b']);

	expect(await notes.deleteFolder(folderEntry(notes, 'work'))).toBeUndefined();
	expect(await text(A)).toContain('folderId: null');
	expect(await text(A)).toContain('Typed first');
	expect(await text('notes/b.md')).toContain('folderId: null');
	expect(await text('folders/work.md')).toBeUndefined();
});

test('a folder deletion saves a note being moved into it, even one the page does not list, then moves it out', async () => {
	const fixture = await openNotes();
	cleanup.push(() => fixture.close());
	const { notes, write, text } = fixture;
	await write('folders/work.md', folderText('Work'));
	await notes.load();
	await write('notes/b.md', noteText({ title: 'B' }));
	await quiet(notes);
	expect(rows(notes)).toEqual([]);
	const b = notes.folder.tables.notes.edit('b');
	expectOk(await b.read());
	expectOk(b.change({ fields: { folderId: 'work' } }));

	expect(await notes.deleteFolder(folderEntry(notes, 'work'))).toBeUndefined();
	expect(b.getPending()).toBeUndefined();
	expect(await text('notes/b.md')).toContain('folderId: null');
	expect(await text('folders/work.md')).toBeUndefined();
});

test('close drains an admitted folder deletion through its later note moves without changing the departing view', async () => {
	const { notes, local, text } = await setup({
		'folders/work.md': folderText('Work'),
		[A]: noteText({ folderId: 'work' }),
	});
	notes.showFolder('work');
	notes.open('folders/work.md', 'text');
	expectOk(
		notes.folder.tables.notes
			.edit('a')
			.change({ body: 'Accepted before departure\n' }),
	);

	const deleting = notes.deleteFolder(folderEntry(notes, 'work'));
	const closing = local.close();
	expect(notes.folder.getStatus().closing).toBe(true);
	expect(await deleting).toBeUndefined();
	expect(await closing).toEqual([]);
	expect(await text(A)).toContain('folderId: null');
	expect(await text(A)).toContain('Accepted before departure');
	expect(await text('folders/work.md')).toBeUndefined();
	expect(notes.view.folderId).toBe('work');
	expect(notes.selected?.path).toBe('folders/work.md');
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
	notes.folder.tables.notes.edit('a').change({ body: 'last words\n' });
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
	});
});

test('close sends typing still waiting, and takes no input from then on', async () => {
	const { notes, local, text } = await setup();
	const note = notes.folder.tables.notes.edit('a');
	note.change({ body: 'typed before close\n' });

	expect(await local.close()).toEqual([]);
	expect(await text(A)).toContain('---\ntyped before close\n');
	expect(notes.fenced).toBe(true);
	expect(note.change({ body: 'late\n' }).error).not.toBeNull();
	expect(await notes.createNote()).toContain('closing');
});

test('closing after a failed file save returns the exact text for recovery', async () => {
	const { notes, local, observe, failSaves, text } = await setup();
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	const changed = noteText({ title: 'Keep this draft' });
	expectOk(typeInto(notes, A, changed));
	failSaves();
	const unsaved = await local.close();
	expect(unsaved).toMatchObject([
		{ path: A, unsaved: changed, error: { name: 'StorageFailed' } },
	]);
	expect(await text(A)).not.toBe(changed);
});

test('a failed file edit stays visible across selection and accepts a field patch over its text', async () => {
	const { notes, observe, failSaves } = await setup({
		[A]: noteText(),
		'notes/b.md': noteText({ title: 'B' }),
	});
	notes.open(A, 'text');
	observe(A);
	await quiet(notes);
	const changed = noteText({ body: 'Keep this unfinished file\n' });
	typeInto(notes, A, changed);
	failSaves();
	await notes.folder.files.edit(A).save();
	notes.open('notes/b.md');
	notes.open(A);
	expect(notes.selected?.as).toBe('note');
	expect(notes.isUnsaved(A)).toBe(true);
	expect(notes.folder.tables.notes.edit('a').getMarkdown()?.body).toBe(
		'Keep this unfinished file\n',
	);
	expect(notes.folder.files.edit(A).getPending()).toMatchObject({
		kind: 'text',
		text: changed,
	});
	failSaves(false);
	expect(notes.patchNote(A, { pinned: true })).toBeUndefined();
	await notes.folder.files.edit(A).save();
	expect(
		notes.folder.tables.notes.edit('a').getMarkdown()?.fields?.pinned,
	).toBe(true);
	expect(notes.folder.tables.notes.edit('a').getMarkdown()?.body).toBe(
		'Keep this unfinished file\n',
	);
});

test('reading a file never sends pending body changes', async () => {
	const { notes, saves, text } = await setup();
	notes.folder.tables.notes.edit('a').change({ body: 'Unsent body\n' });
	const read = await notes.queryClient.fetchQuery(
		notes.queries.file(A, textRead),
	);
	expect(read.kind).toBe('text');
	expect(saves(A)).toBe(0);
	expect(await text(A)).toContain('Body.');
	expect(notes.folder.tables.notes.edit('a').getMarkdown()?.body).toBe(
		'Unsent body\n',
	);
});

test('a folder rename patches held text instead of requiring it to save first', async () => {
	const path = 'folders/f.md';
	const source = folderText('First');
	const { notes, observe, failSaves } = await setup({
		[A]: noteText(),
		[path]: source,
	});
	notes.open(path, 'text');
	observe(path);
	await quiet(notes);
	typeInto(notes, path, source.replace('First', 'Keep this name'));
	failSaves();
	await notes.folder.files.edit(path).save();
	notes.open(A);
	expect(notes.patchFolder(path, { name: 'Other name' })).toBeUndefined();
	expect(notes.folder.files.edit(path).getText()).toContain('Other name');
});
