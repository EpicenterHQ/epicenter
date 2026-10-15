/**
 * Notes State Tests
 *
 * Drives the real notes state and its TanStack Query cache against
 * Honeycrisp's real browser folder over the folder package's in-memory OPFS
 * stand-in. Screens are stood in for as they behave: they observe the
 * queries they show. Another tab's writes go through the folder's API and
 * reach the app on its change channel; another program's writes and
 * removals go below it (`put`, `drop`), so nothing reports them.
 *
 * Key behaviors:
 * - Opening a note writes nothing; an edit is held by the note's draft at
 *   once and saved
 * - Rapid edits run one save at a time, and the edits made meanwhile are
 *   saved next, from the version the save wrote
 * - A read that lands while an edit is held does not replace it, and the
 *   save merges with the change the read brought
 * - A save that meets a change made elsewhere merges with it, and the edit
 *   wins only where both changed
 * - A save that fails keeps the edit on screen and says so; Save again, or
 *   the next change, saves it. A note deleted elsewhere drops the edit,
 *   leaves the list, and offers the text
 * - A change another tab saved shows in the lists and the open note
 * - A note whose text is not a valid note is named for repair, opens as
 *   text, is written as typed, and opens as a note once repaired; while it
 *   is open as text, list actions on it are refused. A text edit over a file
 *   changed elsewhere is refused and offers the text
 * - A note opened as its file while its save runs is read once the save
 *   lands
 * - Deleting a folder moves its notes out first, and is refused while a
 *   note cannot say which folder it is in
 * - Rename and delete wait for the file's saves and act on what the last
 *   one wrote; a file changed elsewhere since is refused
 * - Saves never commit; Save version records one, and delete says when a
 *   file has changes in no saved version
 * - Closing stops input and actions, waits for every save and action, a
 *   whole folder delete included, and every call shares it
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { type Row, rowStemOf } from '@epicenter/folder';
import { expectOk } from 'wellcrafted/testing';
import type { NoteFields } from './data.js';
import {
	type NotesFolderFixture,
	noteText,
	openNotesFolder,
	until,
} from './folder.test-support.js';
import type { Notes, WriteFailure } from './notes.svelte.js';
import {
	cached,
	createQueryClient,
	listing,
	observe,
	quiet,
} from './query.test-support.js';

const { createNotes, foldersOf, repairsOf } = await import('./notes.svelte.ts');

const A = 'notes/a.md';
const B = 'notes/b.md';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

/** The notes state over a fresh folder holding notes `a` and `b`, with its screens observing. */
async function open() {
	const disk = await openNotesFolder();
	await disk.write(A, noteText({ title: 'Alpha', body: 'One.\n' }));
	await disk.write(B, noteText({ title: 'Beta', body: 'Two.\n' }));
	const failures: WriteFailure[] = [];
	const notes = createNotes(disk.host, createQueryClient(), {
		onWriteFailed: (failure) => failures.push(failure),
	});
	let closed = false;
	cleanup.push(() => (closed ? undefined : notes.close()));
	// A test that failed while writes were held still closes.
	cleanup.push(() => disk.release({ all: true }));
	cleanup.push(observe(notes));
	await notes.load();
	await quiet(notes);
	return {
		notes,
		disk,
		failures,
		/** The test closes the notes itself. */
		closing() {
			closed = true;
		},
	};
}

const titled =
	(title: string) =>
	(row: Row<NoteFields>): Row<NoteFields> => ({
		...row,
		fields: { ...row.fields, title },
	});

const bodied =
	(body: string) =>
	(row: Row<NoteFields>): Row<NoteFields> => ({ ...row, body });

const writesTo = (disk: NotesFolderFixture, path: string) =>
	disk.writes().filter((at) => at === path).length;

/** The note at `path` as the views show it now. */
const shown = (notes: Notes, path: string) => notes.noteBody(path).row;

async function sha(notes: Notes, path: string) {
	return expectOk(await notes.host.folder.files.read(path)).sha256;
}

/** Saved versions in history, newest first; none before the first. */
async function versions(notes: Notes) {
	const { data } = await notes.host.folder.git.log(20);
	return data ?? [];
}

/** The folder rows the cache holds. */
const folderRows = (notes: Notes) =>
	foldersOf(
		notes.queryClient.getQueryData(notes.folder$.folders.list.queryKey()) ?? [],
	);

// ============================================================================
// Edits and saves
// ============================================================================

test('opening a note writes nothing, and an edit is held at once and saved', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	const start = writesTo(disk, A);
	notes.open(A);
	expect(notes.selected).toMatchObject({ path: A, as: 'note' });
	await quiet(notes);
	expect(writesTo(disk, A)).toBe(start);
	expect(disk.text(A)).toBe(before);

	expect(notes.editNote(A, titled('Alpha two'))).toBeUndefined();
	expect(shown(notes, A)?.fields.title).toBe('Alpha two');
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Alpha two');
	// A key Honeycrisp does not declare is kept.
	expect(disk.text(A)).toContain('owner');
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha two');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));
});

test('rapid edits run one save at a time, and the edits made meanwhile are saved next', async () => {
	const { notes, disk, failures } = await open();
	const start = writesTo(disk, A);
	disk.hold();
	notes.editNote(A, bodied('O\n'));
	await until(() => disk.held().length === 1, 'the first save to start');
	for (const body of ['On\n', 'One\n', 'One more\n', 'One more time\n'])
		notes.editNote(A, bodied(body));
	expect(disk.held()).toEqual([A]);
	expect(notes.isWriting(A)).toBe(true);
	expect(shown(notes, A)?.body).toBe('One more time\n');

	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	// The held save, then one save of the newest note.
	expect(writesTo(disk, A) - start).toBe(2);
	expect(disk.text(A)).toContain('One more time\n');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));

	notes.editNote(A, bodied('Once more.\n'));
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('Once more.\n');
});

test('a read that lands while an edit is held does not replace it, and the save merges what it brought', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	// Another program changed the body; the report has not arrived yet.
	disk.put(A, noteText({ title: 'Alpha', body: 'Their body.\n' }));
	disk.hold();
	notes.editNote(A, titled('Typed'));
	await until(() => disk.held().length === 1, 'the save to start');
	// The report arrives while the save is held, and the read lands.
	await notes.queryClient.invalidateQueries(notes.folder$.pathFilter([A]));
	expect(cached(notes, 'a').row.body).toBe('Their body.\n');
	// The edit is the draft's: the read changed the cache, not what is shown.
	expect(shown(notes, A)?.fields.title).toBe('Typed');
	expect(shown(notes, A)?.body).toBe('One.\n');

	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Typed');
	expect(disk.text(A)).toContain('Their body.\n');
	expect(shown(notes, A)).toMatchObject({
		fields: { title: 'Typed' },
		body: 'Their body.\n',
	});
});

test('a save that meets a change made elsewhere merges with it: the edit wins only where both changed', async () => {
	const { notes, disk, failures } = await open();
	disk.put(A, noteText({ title: 'Theirs', body: 'Their body.\n' }));

	notes.editNote(A, titled('Mine'));
	await quiet(notes);
	expect(failures).toEqual([]);
	// Both changed the title, so the edit's stands; only they changed the body.
	expect(disk.text(A)).toContain('title: Mine');
	expect(disk.text(A)).toContain('Their body.\n');
	expect(cached(notes, 'a').row.fields.title).toBe('Mine');
	expect(cached(notes, 'a').row.body).toBe('Their body.\n');
});

test('a note deleted elsewhere drops the edit, leaves the list, and nothing writes it again', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.drop(A);
	notes.editNote(A, bodied('Mine.\n'));
	await quiet(notes);
	expect(failures).toMatchObject([
		{ path: A, error: { name: 'NotFound' }, kept: false },
	]);
	expect(failures[0]?.unsaved).toContain('Mine.');
	expect(disk.text(A)).toBeUndefined();
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
	expect(notes.isUnsaved(A)).toBe(false);
});

test('a save that fails keeps the edit on screen and says so, and Save again saves it', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	disk.failNextWrite();
	notes.editNote(A, titled('First'));
	await quiet(notes);
	expect(failures).toMatchObject([{ path: A, kept: true }]);
	expect(failures[0]?.unsaved).toContain('title: First');
	expect(disk.text(A)).toBe(before);
	expect(shown(notes, A)?.fields.title).toBe('First');
	expect(notes.isUnsaved(A)).toBe(true);
	expect(notes.unsaved).toBe(true);

	notes.saveAgain(A);
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(disk.text(A)).toContain('title: First');
	expect(notes.isUnsaved(A)).toBe(false);
	expect(notes.unsaved).toBe(false);
});

test('a value a file cannot hold is refused by the folder, and the file is unchanged', async () => {
	const { notes, disk, failures } = await open();
	const saved = disk.text(A);
	// Inputs commit only values the schema accepts; this bypasses them.
	notes.editNote(A, (row) => ({
		...row,
		fields: { ...row.fields, pinned: 'maybe' as unknown as boolean },
	}));
	await quiet(notes);
	expect(failures).toMatchObject([
		{ path: A, error: { name: 'InvalidValues' } },
	]);
	expect(disk.text(A)).toBe(saved);
	expect(cached(notes, 'a').row.fields.pinned).toBe(false);
});

test("a note's edits wait for its running save, and another note's edit does not", async () => {
	const { notes, disk, failures } = await open();
	disk.hold();
	notes.editNote(A, titled('A typed'));
	await until(() => disk.held().length === 1, 'the save to start');
	notes.editNote(A, titled('A typed again'));
	notes.editNote(B, titled('B typed'));
	// A's second edit waits in its draft; B's save started on its own.
	expect(notes.isWriting(A)).toBe(true);
	expect(notes.isWriting(B)).toBe(true);
	expect(disk.held()).toEqual([A]);
	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: A typed again');
	expect(disk.text(B)).toContain('title: B typed');
});

test('a change another tab saved shows in the lists and the open note', async () => {
	const { notes, disk } = await open();
	notes.open(A);
	const tab = await disk.otherTab();
	const theirs = expectOk(await tab.tables.notes.get('a'));
	if (theirs === undefined) throw new Error('No note a');
	expectOk(await tab.tables.notes.save(theirs, titled('Theirs')(theirs.row)));
	expectOk(await tab.files.create('notes/c.md', noteText({ title: 'Gamma' })));
	await until(
		() =>
			listing(notes).some((entry) => entry.stem === 'c') &&
			shown(notes, A)?.fields.title === 'Theirs',
		'the reported change to be read',
	);
	await quiet(notes);
	expect(cached(notes, 'c').row.fields.title).toBe('Gamma');
});

// ============================================================================
// Repair as text
// ============================================================================

test('a note whose text is not a note is named for repair, opens as text, is written as typed, and opens as a note once repaired', async () => {
	const { notes, disk, failures } = await open();
	const broken = '---\ntitle: Gamma\npinned: maybe\n---\nBody.\n';
	const tab = await disk.otherTab();
	expectOk(await tab.files.create('notes/c.md', broken));
	await until(
		() => repairsOf(listing(notes)).length === 1,
		'the reported file to be read',
	);
	expect(repairsOf(listing(notes)).map((repair) => repair.path)).toEqual([
		'notes/c.md',
	]);
	notes.open('notes/c.md');
	expect(notes.selected).toMatchObject({ path: 'notes/c.md', as: 'text' });
	const stop = observe(notes, 'notes/c.md');
	cleanup.push(stop);
	await quiet(notes);
	// A list action on a file open as text is refused; its text is what saves.
	expect(notes.patchNote('notes/c.md', { pinned: true })).toBeDefined();
	const repaired = noteText({ title: 'Gamma', body: 'Body.\n' });
	expect(notes.editText('notes/c.md', repaired)).toBe(true);
	expect(notes.typedText('notes/c.md')).toBe(repaired);
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text('notes/c.md')).toBe(repaired);
	expect(notes.typedText('notes/c.md')).toBeUndefined();
	expect(repairsOf(listing(notes))).toEqual([]);
	notes.open('notes/c.md', 'note');
	expect(notes.selected).toMatchObject({ path: 'notes/c.md', as: 'note' });
	expect(cached(notes, 'c').row.fields.title).toBe('Gamma');
});

test('a note open as its file is a text edit, and the list shows it after the write', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A, 'text');
	cleanup.push(observe(notes, A));
	await quiet(notes);
	expect(notes.patchNote(A, { pinned: true })).toContain('open as text');
	const text = (disk.text(A) ?? '').replace(
		'"title": "Alpha"',
		'title: By hand',
	);
	expect(text).toContain('title: By hand');
	expect(notes.editText(A, text)).toBe(true);
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBe(text);
	expect(cached(notes, 'a').row.fields.title).toBe('By hand');
});

test('a text edit over a file changed elsewhere is refused, shows the file, and offers the text', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A, 'text');
	cleanup.push(observe(notes, A));
	await quiet(notes);
	disk.put(A, noteText({ title: 'Theirs' }));
	expect(notes.editText(A, 'Mine\n')).toBe(true);
	await quiet(notes);
	expect(failures).toMatchObject([
		{ path: A, error: { name: 'Conflict' }, unsaved: 'Mine\n', kept: false },
	]);
	expect(disk.text(A)).toBe(noteText({ title: 'Theirs' }));
	expect(notes.typedText(A)).toBeUndefined();
	const opened = notes.queryClient.getQueryData<{ file: { text: string } }>(
		notes.textQuery(A).queryKey,
	);
	expect(opened?.file.text).toBe(noteText({ title: 'Theirs' }));
});

test('a note opened as its file while its save runs is read once the save lands', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.hold();
	notes.editNote(A, titled('Typed as a note'));
	await until(() => disk.held().length === 1, 'the save to start');
	notes.open(A, 'text');
	cleanup.push(observe(notes, A));
	await Bun.sleep(5);
	const textKey = notes.textQuery(A).queryKey;
	expect(notes.queryClient.getQueryData(textKey)).toBeUndefined();
	disk.release({ all: true });
	await quiet(notes);
	const opened = notes.queryClient.getQueryData<{
		kind: string;
		file: { text: string };
	}>(textKey);
	expect(opened?.file.text).toContain('title: Typed as a note');
	// Its text writes on top of what the note saved, with no conflict.
	expect(
		notes.editText(A, (opened?.file.text ?? '').replace('Typed', 'Then typed')),
	).toBe(true);
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Then typed as a note');
});

// ============================================================================
// List and folder actions
// ============================================================================

test('a list action is an edit like any other, saved at once', async () => {
	const { notes, disk, failures } = await open();
	expect(notes.trashNote(B)).toBeUndefined();
	await quiet(notes);
	expect(disk.text(B)).toMatch(/deletedAt: "?\d{4}-/);
	expect(notes.restoreNote(B)).toBeUndefined();
	expect(notes.patchNote(B, { pinned: true })).toBeUndefined();
	// The open note and the lists share the edit before its save lands.
	expect(shown(notes, B)?.fields).toMatchObject({
		pinned: true,
		deletedAt: null,
	});
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(B)).toContain('deletedAt: null');
	expect(disk.text(B)).toContain('pinned: true');
});

test('a new note is created in the folder shown and opened', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = folderRows(notes);
	if (work === undefined) throw new Error('No folder');
	notes.showFolder(work.stem);
	expect(await notes.createNote()).toBeUndefined();
	const path = notes.selected?.path ?? '';
	expect(notes.selected).toMatchObject({ as: 'note' });
	const stem = rowStemOf('notes', path) ?? '';
	expect(cached(notes, stem).row.fields.folderId).toBe(work.stem);
	expect(disk.text(path)).toContain(work.stem);
});

test('deleting a folder moves its notes out first, then deletes its file', async () => {
	const { notes, disk, failures } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = folderRows(notes);
	if (work === undefined) throw new Error('No folder');
	notes.patchNote(A, { folderId: work.stem });
	notes.patchNote(B, { folderId: work.stem });
	notes.open(A);
	expect(await notes.deleteFolder(work)).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(work.path)).toBeUndefined();
	expect(disk.text(A)).toContain('folderId: null');
	expect(disk.text(B)).toContain('folderId: null');
	expect(cached(notes, 'a').row.fields.folderId).toBeNull();
	expect(folderRows(notes)).toEqual([]);
});

test('a folder is not deleted while a note cannot say which folder it is in', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = folderRows(notes);
	if (work === undefined) throw new Error('No folder');
	const tab = await disk.otherTab();
	expectOk(await tab.files.create('notes/c.md', 'no frontmatter\n'));
	await until(
		() => listing(notes).some((entry) => entry.stem === 'c'),
		'the reported file to be read',
	);
	expect(await notes.deleteFolder(work)).toContain('c.md');
	expect(disk.text(work.path)).toBeDefined();
});

test('a folder name is an edit to its row, saved at once', async () => {
	const { notes, disk, failures } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = folderRows(notes);
	if (work === undefined) throw new Error('No folder');
	expect(notes.patchFolder(work.path, { name: 'Play' })).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(work.path)).toContain('name: Play');
});

// ============================================================================
// Rename and delete
// ============================================================================

test('a rename waits for the save and moves what it wrote; the open note follows it', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	const opening = notes.selected;
	if (opening === undefined) throw new Error('Nothing opened');
	disk.hold();
	notes.editNote(A, bodied('Before the rename.\n'));
	await until(() => disk.held().length === 1, 'the save to start');
	const renaming = notes.rename(A, 'renamed.md');
	// Edits wait while the rename runs.
	expect(notes.editNote(A, bodied('During.\n'))).toBeDefined();
	disk.release({ all: true });
	expect(await renaming).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(notes.selected).toEqual({ ...opening, path: 'notes/renamed.md' });
	expect(disk.text(A)).toBeUndefined();
	expect(disk.text('notes/renamed.md')).toContain('Before the rename.\n');
	notes.editNote('notes/renamed.md', bodied('After.\n'));
	await quiet(notes);
	expect(disk.text('notes/renamed.md')).toContain('After.\n');
	expect(await notes.rename('notes/renamed.md', 'plain.txt')).toContain('.md');
});

test('a name some disk reads as another file is refused in words a person reads, and a leading dot works', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFile('notes', '.hidden.md')).toBeUndefined();
	expect(disk.text('notes/.hidden.md')).toBe('');
	for (const [name, reason] of [
		['draft.', 'cannot end with a dot or a space'],
		['draft ', 'cannot end with a dot or a space'],
		['a:b.md', 'cannot contain < > : " | ? or *'],
		['con.md', 'Windows keeps for a device'],
		['NOTES~1', 'Windows short name'],
		['HEAD', 'Git keeps for itself'],
	] as const) {
		expect(await notes.createFile('notes', name)).toContain(reason);
		expect(disk.text(`notes/${name}`)).toBeUndefined();
	}
	expect(await notes.createDirectory('', 'old ')).toContain(
		'cannot end with a dot or a space',
	);
	expect(await notes.rename(A, 'a.md.')).toContain(
		'cannot end with a dot or a space',
	);
	expect(disk.text(A)).toContain('Alpha');
});

test('a delete waits for the save and removes what it wrote', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	const deletion = expectOk(await notes.deletionFor(A));
	expect(deletion).toMatchObject({ kind: 'file', title: 'Alpha' });
	// Typed while the confirmation is open: saved, then deleted.
	notes.editNote(A, bodied('Typed during the dialog.\n'));
	expect(await notes.remove(deletion)).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBeUndefined();
	expect(notes.selected).toBeUndefined();
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
});

test('a delete is refused when the file changed elsewhere after it was confirmed', async () => {
	const { notes, disk } = await open();
	const deletion = expectOk(await notes.deletionFor(B));
	disk.put(B, noteText({ title: 'Changed' }));
	expect(await notes.remove(deletion)).toContain('changed elsewhere');
	expect(disk.text(B)).toBe(noteText({ title: 'Changed' }));
});

// ============================================================================
// Versions
// ============================================================================

test('nothing commits on its own after edits; Save version records one, and delete says when changes are in no saved version', async () => {
	const { notes, failures } = await open();
	const before = await versions(notes);
	notes.editNote(A, titled('Edited'));
	await quiet(notes);
	notes.editNote(A, bodied('Edited again.\n'));
	notes.patchNote(B, { pinned: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(await versions(notes)).toEqual(before);
	expect(notes.git.lastCommit).toBeUndefined();
	expect(expectOk(await notes.deletionFor(A))).toMatchObject({
		unversioned: true,
	});

	const outcome = expectOk(await notes.saveVersion());
	expect(outcome.status).toBe('committed');
	const [head] = await versions(notes);
	expect(head?.oid).toBe(outcome.status === 'committed' ? outcome.oid : '');
	await quiet(notes);
	expect(expectOk(await notes.deletionFor(A))).toMatchObject({
		unversioned: false,
	});

	notes.editNote(A, titled('After the version'));
	await quiet(notes);
	expect(await versions(notes)).toHaveLength(before.length + 1);
	expect(expectOk(await notes.deletionFor(A))).toMatchObject({
		unversioned: true,
	});
});

test('Save version waits for saves still running, and records what they wrote', async () => {
	const { notes, disk } = await open();
	disk.hold();
	notes.editNote(A, titled('In flight'));
	await until(() => disk.held().length === 1, 'the save to start');
	const saving = notes.saveVersion();
	disk.release({ all: true });
	const outcome = expectOk(await saving);
	expect(outcome.status).toBe('committed');
	const { data: committed } = await notes.host.folder.git.status();
	expect(committed?.changes.some((change) => change.path === A)).toBe(false);
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for a running save, every call shares one completion, and nothing starts after', async () => {
	const { notes, disk, closing } = await open();
	closing();
	disk.hold();
	notes.editNote(A, bodied('Last words.\n'));
	await until(() => disk.held().length === 1, 'the save to start');
	let closed = false;
	const first = notes.close();
	const second = notes.close();
	expect(second).toBe(first);
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	expect(notes.editNote(A, bodied('Too late.\n'))).toContain('closing');
	expect(await notes.createNote()).toContain('closing');
	expect(notes.noteBody(A).locked).toBe(true);
	disk.release({ all: true });
	await first;
	expect(disk.text(A)).toContain('Last words.\n');
});

test('close waits for a whole folder delete, not only the save running when it began', async () => {
	const { notes, disk, closing } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = folderRows(notes);
	if (work === undefined) throw new Error('No folder');
	notes.patchNote(B, { folderId: work.stem });
	await quiet(notes);
	closing();
	disk.hold();
	const deleting = notes.deleteFolder(work);
	await until(() => disk.held().length === 1, 'the note to start moving out');
	const closed = notes.close();
	disk.release({ all: true });
	expect(await deleting).toBeUndefined();
	await closed;
	expect(disk.text(B)).toContain('folderId: null');
	expect(disk.text(work.path)).toBeUndefined();
});
