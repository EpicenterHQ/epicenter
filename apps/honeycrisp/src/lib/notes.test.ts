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
 * - Opening a note writes nothing; a field is a set of the file as it
 *   is now, and a body typed is held by the note's body draft and saved
 * - A body typed while its save runs is saved next, from the body the
 *   save sent
 * - A read that lands while a body is held does not replace it, and the
 *   save merges with the change the read brought
 * - A set over a change made elsewhere keeps the fields it did not set
 * - A body save that fails keeps the body on screen and says so; Save
 *   again, or the next change, saves it. A body saved over a delete writes
 *   nothing, and is dropped with its text offered once, whether the save
 *   found the delete or a report did; a reported delete takes the note off
 *   the list, and it takes no edit
 * - One note's writes run one at a time; another note's do not wait
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
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { type Row, rowStemOf } from '@epicenter/folder';
import { createFolderContext } from '@epicenter/svelte/folder';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { expectOk } from 'wellcrafted/testing';
import type { NoteFields } from './data.js';
import {
	type NotesFolderFixture,
	noteText,
	openNotesFolder,
	until,
} from './folder.test-support.js';
import type { Notes } from './notes.svelte.js';
import { cached, listing, observe, quiet } from './query.test-support.js';

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
	const opened = createFolderContext(disk.folder, {
		writeFailed: (failure) => failures.push(failure),
	});
	const notes = createNotes(opened);
	cleanup.push(() => disk.close());
	let closed = false;
	cleanup.push(() => (closed ? undefined : opened.close()));
	// A test that failed while writes were held still closes.
	cleanup.push(() => disk.release({ all: true }));
	cleanup.push(observe(notes));
	await notes.load();
	await quiet(notes);
	return {
		notes,
		opened,
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

/**
 * Type `body` into the note at `path` and send it, as a view does once the
 * person pauses or leaves; answers why it was refused, if it was.
 */
function typeBody(notes: Notes, path: string, body: string) {
	const refused = notes.editBody(path, body);
	if (refused === undefined) void notes.saveBody(path);
	return refused;
}

/** Type `text` as the file at `path` and send it, as the file view does once the person pauses. */
function typeText(notes: Notes, path: string, text: string) {
	const taken = notes.editText(path, text);
	void notes.saveText(path);
	return taken;
}

const writesTo = (disk: NotesFolderFixture, path: string) =>
	disk.writes().filter((at) => at === path).length;

/** The note at `path` as the views show it now. */
const shown = (notes: Notes, path: string) => notes.noteBody(path).row;

async function sha(notes: Notes, path: string) {
	return expectOk(await notes.folder.files.read(path)).sha256;
}

/** Saved versions in history, newest first; none before the first. */
async function versions(notes: Notes) {
	const { data } = await notes.folder.git.log(20);
	return data ?? [];
}

/** The folder rows the cache holds. */
const folderRows = (notes: Notes) =>
	foldersOf(
		notes.queryClient.getQueryData(notes.queries.folders.list.queryKey()) ?? [],
	);

// ============================================================================
// Edits and saves
// ============================================================================

test('opening a note writes nothing, and a set is saved', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	const start = writesTo(disk, A);
	notes.open(A);
	expect(notes.selected).toMatchObject({ path: A, as: 'note' });
	await quiet(notes);
	expect(writesTo(disk, A)).toBe(start);
	expect(disk.text(A)).toBe(before);

	expect(notes.patchNote(A, { title: 'Alpha two' })).toBeUndefined();
	await quiet(notes);
	expect(shown(notes, A)?.fields.title).toBe('Alpha two');
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Alpha two');
	// A key Honeycrisp does not declare is kept.
	expect(disk.text(A)).toContain('owner');
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha two');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));
});

test('a body typed while its save runs is saved next, from the body it sent', async () => {
	const { notes, disk, failures } = await open();
	const start = writesTo(disk, A);
	disk.hold();
	typeBody(notes, A, 'O\n');
	await until(() => disk.held().length === 1, 'the first save to start');
	for (const body of ['On\n', 'One\n', 'One more\n', 'One more time\n'])
		typeBody(notes, A, body);
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

	typeBody(notes, A, 'Once more.\n');
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('Once more.\n');
});

test('a read that lands while a body is held does not replace it, and the save merges what it brought', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	// Another program changed the title; the report has not arrived yet.
	disk.put(A, noteText({ title: 'Theirs', body: 'One.\n' }));
	disk.hold();
	typeBody(notes, A, 'Typed.\n');
	await until(() => disk.held().length === 1, 'the save to start');
	// The report arrives while the save is held, and the read lands.
	await notes.queryClient.invalidateQueries(notes.queries.pathFilter([A]));
	expect(cached(notes, 'a').row.fields.title).toBe('Theirs');
	// The body is the draft's: the read changed the cache, not what is shown.
	expect(shown(notes, A)?.body).toBe('Typed.\n');

	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toMatch(/^"?title"?: "?Theirs"?$/m);
	expect(disk.text(A)).toContain('Typed.\n');
	expect(shown(notes, A)).toMatchObject({
		fields: { title: 'Theirs' },
		body: 'Typed.\n',
	});
});

test('a set over a change made elsewhere keeps the fields it did not set', async () => {
	const { notes, disk, failures } = await open();
	disk.put(A, noteText({ title: 'Theirs', body: 'Their body.\n' }));

	notes.patchNote(A, { title: 'Mine' });
	await quiet(notes);
	expect(failures).toEqual([]);
	// The title is the set's; only they changed the body, so it stays.
	expect(disk.text(A)).toContain('title: Mine');
	expect(disk.text(A)).toContain('Their body.\n');
	expect(cached(notes, 'a').row.fields.title).toBe('Mine');
	expect(cached(notes, 'a').row.body).toBe('Their body.\n');
});

test('a body saved over a delete not yet reported writes nothing, and the text is offered', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.drop(A);
	typeBody(notes, A, 'Mine.\n');
	await quiet(notes);
	// A delete beats an edit that never saw it.
	expect(disk.text(A)).toBeUndefined();
	expect(failures).toMatchObject([
		{
			path: A,
			error: { name: 'NotStarted' },
			unsaved: 'Mine.\n',
		},
	]);
	expect(notes.isUnsaved(A)).toBe(false);
	expect(notes.unsaved).toBe(false);
	// The listing read once the save found the note gone offers it no second time.
	await notes.queryClient.invalidateQueries(notes.queries.pathFilter([A]));
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
});

test('a body typed and not yet saved when a delete is reported is dropped and offered once', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	// Typed, and waiting for the pause before it saves.
	expect(notes.editBody(A, 'Mine.\n')).toBeUndefined();
	disk.drop(A);
	await notes.queryClient.invalidateQueries(notes.queries.pathFilter([A]));
	await quiet(notes);
	expect(failures).toMatchObject([
		{
			path: A,
			error: { name: 'NotStarted' },
			unsaved: 'Mine.\n',
		},
	]);
	expect(notes.isUnsaved(A)).toBe(false);
	expect(notes.unsaved).toBe(false);
	expect(disk.text(A)).toBeUndefined();
	// A later read of the listing offers it no second time.
	await notes.queryClient.invalidateQueries(notes.queries.pathFilter([B]));
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(disk.text(A)).toBeUndefined();
});

test('a note deleted elsewhere leaves the list once reported, and takes no edit', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.drop(A);
	await notes.queryClient.invalidateQueries(notes.queries.pathFilter([A]));
	await quiet(notes);
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
	expect(typeBody(notes, A, 'Mine.\n')).toBeDefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBeUndefined();
});

test('a body save that fails keeps the body on screen and says so, and Save again saves it', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	disk.failNextWrite();
	typeBody(notes, A, 'First.\n');
	await quiet(notes);
	expect(failures).toMatchObject([{ path: A }]);
	expect(failures[0]?.unsaved).toContain('First.');
	// The body is still on screen, so the toast offers Save again.
	expect(failures[0]?.retry).toBeInstanceOf(Function);
	expect(disk.text(A)).toBe(before);
	expect(shown(notes, A)?.body).toBe('First.\n');
	expect(notes.isUnsaved(A)).toBe(true);
	expect(notes.unsaved).toBe(true);

	failures[0]?.retry?.();
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(disk.text(A)).toContain('First.\n');
	expect(notes.isUnsaved(A)).toBe(false);
	expect(notes.unsaved).toBe(false);
});

test('a set that fails is reported and writes nothing', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	disk.failNextWrite();
	notes.patchNote(A, { title: 'First' });
	await quiet(notes);
	expect(failures).toMatchObject([{ path: A, unsaved: '' }]);
	expect(disk.text(A)).toBe(before);
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha');
});

test('a value a file cannot hold is refused by the folder, and the file is unchanged', async () => {
	const { notes, disk, failures } = await open();
	const saved = disk.text(A);
	// Inputs commit only values the schema accepts; this bypasses them.
	notes.patchNote(A, { pinned: 'maybe' as unknown as boolean });
	await quiet(notes);
	expect(failures).toMatchObject([
		{ path: A, error: { name: 'InvalidValues' } },
	]);
	expect(disk.text(A)).toBe(saved);
	expect(cached(notes, 'a').row.fields.pinned).toBe(false);
});

test("a note's sets wait for its running write, and another note's do not", async () => {
	const { notes, disk, failures } = await open();
	disk.hold();
	notes.patchNote(A, { title: 'A typed' });
	await until(() => disk.held().length === 1, 'the save to start');
	notes.patchNote(A, { title: 'A typed again' });
	notes.patchNote(B, { title: 'B typed' });
	// A's second set waits its turn; B's started on its own.
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
	expectOk(
		await tab.tables.notes.write('a', theirs.row, titled('Theirs')(theirs.row)),
	);
	expectOk(await tab.write('notes/c.md', null, noteText({ title: 'Gamma' })));
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
	expectOk(await tab.write('notes/c.md', null, broken));
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
	expect(typeText(notes, 'notes/c.md', repaired)).toBe(true);
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
	expect(typeText(notes, A, text)).toBe(true);
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBe(text);
	expect(cached(notes, 'a').row.fields.title).toBe('By hand');
});

test('a text edit over a file changed elsewhere merges by line, and the edit wins the lines both changed', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A, 'text');
	cleanup.push(observe(notes, A));
	await quiet(notes);
	const theirs = noteText({ title: 'Theirs' });
	disk.put(A, theirs);
	expect(typeText(notes, A, 'Mine\n')).toBe(true);
	await quiet(notes);
	// Both changed the same lines: the edit's stand.
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBe('Mine\n');
	expect(notes.typedText(A)).toBeUndefined();
	const opened = () =>
		notes.queryClient.getQueryData<{ text: string }>(
			notes.textQuery(A).queryKey,
		)?.text;
	expect(opened()).toBe('Mine\n');
});

test('a note opened as its file while its save runs is read once the save lands', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.hold();
	notes.patchNote(A, { title: 'Typed as a note' });
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
		text: string;
	}>(textKey);
	expect(opened?.text).toContain('title: Typed as a note');
	// Its text writes on top of what the note saved, with no conflict.
	expect(
		typeText(notes, A, (opened?.text ?? '').replace('Typed', 'Then typed')),
	).toBe(true);
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Then typed as a note');
});

// ============================================================================
// List and folder actions
// ============================================================================

test('a list action is a set like any other, saved at once', async () => {
	const { notes, disk, failures } = await open();
	expect(notes.trashNote(B)).toBeUndefined();
	await quiet(notes);
	expect(disk.text(B)).toMatch(/deletedAt: "?\d{4}-/);
	expect(notes.restoreNote(B)).toBeUndefined();
	expect(notes.patchNote(B, { pinned: true })).toBeUndefined();
	await quiet(notes);
	expect(shown(notes, B)?.fields).toMatchObject({
		pinned: true,
		deletedAt: null,
	});
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
	expectOk(await tab.write('notes/c.md', null, 'no frontmatter\n'));
	await until(
		() => listing(notes).some((entry) => entry.stem === 'c'),
		'the reported file to be read',
	);
	expect(await notes.deleteFolder(work)).toContain('c.md');
	expect(disk.text(work.path)).toBeDefined();
});

test('a folder name is a set of its row, saved at once', async () => {
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
	typeBody(notes, A, 'Before the rename.\n');
	await until(() => disk.held().length === 1, 'the save to start');
	const renaming = notes.rename(A, 'renamed.md');
	// Edits wait while the rename runs.
	expect(typeBody(notes, A, 'During.\n')).toBeDefined();
	disk.release({ all: true });
	expect(await renaming).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(notes.selected).toEqual({ ...opening, path: 'notes/renamed.md' });
	expect(disk.text(A)).toBeUndefined();
	expect(disk.text('notes/renamed.md')).toContain('Before the rename.\n');
	typeBody(notes, 'notes/renamed.md', 'After.\n');
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

test('a delete waits for the save and deletes what it wrote', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	const deletion = expectOk(await notes.deletionFor(A));
	expect(deletion).toMatchObject({ kind: 'file', title: 'Alpha' });
	// Typed while the confirmation is open: saved, then deleted.
	typeBody(notes, A, 'Typed during the dialog.\n');
	expect(await notes.delete(deletion)).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toBeUndefined();
	expect(notes.selected).toBeUndefined();
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
});

test('a delete stands over a change made elsewhere after it was confirmed: the deleter wins', async () => {
	const { notes, disk } = await open();
	const deletion = expectOk(await notes.deletionFor(B));
	disk.put(B, noteText({ title: 'Changed' }));
	expect(await notes.delete(deletion)).toBeUndefined();
	expect(disk.text(B)).toBeUndefined();
});

// ============================================================================
// Versions
// ============================================================================

test('nothing commits on its own after edits; Save version records one, and delete says when changes are in no saved version', async () => {
	const { notes, failures } = await open();
	const before = await versions(notes);
	notes.patchNote(A, { title: 'Edited' });
	await quiet(notes);
	typeBody(notes, A, 'Edited again.\n');
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

	notes.patchNote(A, { title: 'After the version' });
	await quiet(notes);
	expect(await versions(notes)).toHaveLength(before.length + 1);
	expect(expectOk(await notes.deletionFor(A))).toMatchObject({
		unversioned: true,
	});
});

test('Save version waits for saves still running, and records what they wrote', async () => {
	const { notes, disk } = await open();
	disk.hold();
	notes.patchNote(A, { title: 'In flight' });
	await until(() => disk.held().length === 1, 'the save to start');
	const saving = notes.saveVersion();
	disk.release({ all: true });
	const outcome = expectOk(await saving);
	expect(outcome.status).toBe('committed');
	const { data: committed } = await notes.folder.git.status();
	expect(committed?.changes.some((change) => change.path === A)).toBe(false);
});

// ============================================================================
// Closing
// ============================================================================

test('close waits for a running save, every call shares one completion, and nothing starts after', async () => {
	const { notes, opened, disk, closing } = await open();
	closing();
	disk.hold();
	typeBody(notes, A, 'Last words.\n');
	await until(() => disk.held().length === 1, 'the save to start');
	let closed = false;
	const first = opened.close();
	const second = opened.close();
	expect(second).toBe(first);
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	expect(typeBody(notes, A, 'Too late.\n')).toContain('closing');
	expect(await notes.createNote()).toContain('closing');
	expect(notes.noteBody(A).locked).toBe(true);
	disk.release({ all: true });
	await first;
	expect(disk.text(A)).toContain('Last words.\n');
});

test('close waits for a whole folder delete, not only the save running when it began', async () => {
	const { notes, opened, disk, closing } = await open();
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
	const closed = opened.close();
	disk.release({ all: true });
	expect(await deleting).toBeUndefined();
	await closed;
	expect(disk.text(B)).toContain('folderId: null');
	expect(disk.text(work.path)).toBeUndefined();
});
