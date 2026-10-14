/**
 * Notes State Tests
 *
 * Drives the real notes state and its TanStack Query cache against
 * Honeycrisp's real browser folder over the folder package's in-memory OPFS
 * stand-in. Screens are stood in for as they behave: they observe the
 * queries they show. Another program's writes and removals go below the
 * folder's API (`put`, `drop`), so the app sees them only when it reads.
 *
 * Key behaviors:
 * - Opening a note writes nothing; an edit changes the cache at once and is
 *   written to the file
 * - Rapid edits run one write at a time per file with one waiting, which
 *   saves the newest note, guarded by the hash the previous write confirmed
 * - No read starts while a write runs: not on returning to the window, not
 *   when a view mounts
 * - A write that meets a change made elsewhere, that fails, or that holds a
 *   value a file cannot, rolls the cache back to the file and reports the
 *   text that was lost
 * - Returning to the window shows a change made elsewhere
 * - A note whose text is not a valid note is named for repair, opens as
 *   text, is written as typed, and opens as a note once repaired; while it
 *   is open as text, list actions on it are refused
 * - A note opened as its file while its write runs is read once the write
 *   lands
 * - Deleting a folder moves its notes out first, and is refused while a
 *   note cannot say which folder it is in
 * - Rename and delete run after the file's queued writes and act on what
 *   the last one saved; a file changed elsewhere since is refused
 * - Saves never commit; Save version records one, and delete says when a
 *   file has changes in no saved version
 * - The close fence stops input and actions; close waits for every write
 *   and action, a whole folder delete included, and every call shares it
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
	focusManager,
	listing,
	observe,
	QueryObserver,
	quiet,
} from './query.test-support.js';

const { createNotes, foldersOf, notesKeys, repairsOf } = await import(
	'./notes.svelte.ts'
);

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

async function sha(notes: Notes, path: string) {
	return expectOk(await notes.host.folder.files.read(path)).sha256;
}

/** Saved versions in history, newest first; none before the first. */
async function versions(notes: Notes) {
	const { data } = await notes.host.folder.git.log(20);
	return data ?? [];
}

// ============================================================================
// Edits and writes
// ============================================================================

test('opening a note writes nothing, and an edit changes the cache at once and is written', async () => {
	const { notes, disk, failures } = await open();
	const before = disk.text(A);
	const start = writesTo(disk, A);
	notes.open(A);
	expect(notes.selected).toMatchObject({ path: A, as: 'note' });
	await quiet(notes);
	expect(writesTo(disk, A)).toBe(start);
	expect(disk.text(A)).toBe(before);

	expect(notes.editNote(A, titled('Alpha two'))).toBeUndefined();
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha two');
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Alpha two');
	// A key Honeycrisp does not declare is kept.
	expect(disk.text(A)).toContain('owner');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));
});

test('rapid edits run one write at a time with one waiting, which saves the newest note with no conflict', async () => {
	const { notes, disk, failures } = await open();
	const start = writesTo(disk, A);
	disk.hold();
	notes.editNote(A, bodied('O\n'));
	await until(() => disk.held().length === 1, 'the first write to start');
	for (const body of ['On\n', 'One\n', 'One more\n', 'One more time\n'])
		notes.editNote(A, bodied(body));
	// One write runs and one waits; no more were queued.
	expect(
		notes.queryClient.isMutating({ mutationKey: notesKeys.write(A) }),
	).toBe(2);
	expect(cached(notes, 'a').row.body).toBe('One more time\n');

	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	// The held write, then one write of the newest note.
	expect(writesTo(disk, A) - start).toBe(2);
	expect(disk.text(A)).toContain('One more time\n');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));

	// The guard moved forward: the next edit writes on top.
	notes.editNote(A, bodied('Once more.\n'));
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('Once more.\n');
});

test('no read starts while a write runs: not on returning to the window, not when a view mounts', async () => {
	const { notes, disk, failures } = await open();
	disk.hold();
	notes.editNote(A, titled('Typed'));
	await until(() => disk.held().length === 1, 'the write to start');
	// Returning to the window while the write is held reads nothing.
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	// The client refetches on focus a tick later, after resuming paused writes.
	await Bun.sleep(0);
	// Neither does a view that mounts now.
	const mounted = new QueryObserver(
		notes.queryClient,
		notes.notesQuery(),
	).subscribe(() => {});
	expect(
		notes.queryClient.isFetching({ queryKey: notesKeys.rows('notes') }),
	).toBe(0);
	expect(cached(notes, 'a').row.fields.title).toBe('Typed');
	disk.release({ all: true });
	await quiet(notes);
	mounted();
	expect(failures).toEqual([]);
	expect(cached(notes, 'a').row.fields.title).toBe('Typed');
	expect(cached(notes, 'a').sha256).toBe(await sha(notes, A));

	notes.editNote(A, titled('Typed again'));
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: Typed again');
});

test('a write that meets a change made elsewhere rolls back to the file and reports the lost text', async () => {
	const { notes, disk, failures } = await open();
	const elsewhere = noteText({ title: 'Theirs', body: 'Their body.\n' });
	disk.put(A, elsewhere);

	notes.editNote(A, titled('Mine'));
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ path: A, error: { name: 'Conflict' } });
	expect(failures[0]?.lost).toContain('title: Mine');
	// The cache shows the file again; nothing was written over it.
	expect(disk.text(A)).toBe(elsewhere);
	expect(cached(notes, 'a').row.fields.title).toBe('Theirs');
	expect(cached(notes, 'a').row.body).toBe('Their body.\n');

	// The next edit writes on top of what is there now.
	notes.editNote(A, titled('Mine'));
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(disk.text(A)).toContain('title: Mine');
	expect(disk.text(A)).toContain('Their body.\n');
});

test('a note deleted elsewhere rolls back out of the list, and nothing writes it again', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.drop(A);
	notes.editNote(A, bodied('Mine.\n'));
	await quiet(notes);
	expect(failures).toMatchObject([{ path: A, error: { name: 'Conflict' } }]);
	expect(failures[0]?.lost).toContain('Mine.');
	expect(disk.text(A)).toBeUndefined();
	expect(listing(notes).some((entry) => entry.stem === 'a')).toBe(false);
});

test('a write that fails rolls back, and the write waiting behind it saves the note as the file holds it', async () => {
	const { notes, disk, failures } = await open();
	disk.failNextWrite();
	notes.editNote(A, titled('First'));
	notes.editNote(A, titled('Second'));
	expect(
		notes.queryClient.isMutating({ mutationKey: notesKeys.write(A) }),
	).toBe(2);
	await quiet(notes);
	// The rollback lands before the waiting write runs, so it saves the
	// file's own note and fails nothing.
	expect(failures.map((failure) => failure.lost)).toEqual([
		expect.stringContaining('title: Second'),
	]);
	expect(disk.text(A)).toContain('title: Alpha\n');
	expect(disk.text(A)).not.toContain('Second');
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha');
});

test('a value a file cannot hold is refused by the folder, and the cache rolls back', async () => {
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

test('writes to one note wait for each other, and writes to different notes do not', async () => {
	const { notes, disk, failures } = await open();
	disk.hold();
	notes.editNote(A, titled('A typed'));
	await until(() => disk.held().length === 1, 'the write to start');
	notes.editNote(A, titled('A typed again'));
	notes.editNote(B, titled('B typed'));
	const paused = (path: string) =>
		notes.queryClient
			.getMutationCache()
			.findAll({ mutationKey: notesKeys.write(path) })
			.map((write) => write.state.isPaused);
	// A's second write waits in A's queue; B's write is not held by A's.
	expect(paused(A)).toEqual([false, true]);
	expect(paused(B)).toEqual([false]);
	disk.release({ all: true });
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(A)).toContain('title: A typed again');
	expect(disk.text(B)).toContain('title: B typed');
});

test('returning to the window shows a change made elsewhere', async () => {
	const { notes, disk } = await open();
	notes.open(A);
	disk.put(A, noteText({ title: 'Theirs' }));
	disk.put('notes/c.md', noteText({ title: 'Gamma' }));
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await Bun.sleep(0);
	await quiet(notes);
	expect(cached(notes, 'a').row.fields.title).toBe('Theirs');
	expect(cached(notes, 'c').row.fields.title).toBe('Gamma');
});

// ============================================================================
// Repair as text
// ============================================================================

test('a note whose text is not a note is named for repair, opens as text, is written as typed, and opens as a note once repaired', async () => {
	const { notes, disk, failures } = await open();
	const broken = '---\ntitle: Gamma\npinned: maybe\n---\nBody.\n';
	disk.put('notes/c.md', broken);
	await notes.refresh();
	await quiet(notes);
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
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text('notes/c.md')).toBe(repaired);
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

test('a note opened as its file while its write runs is read once the write lands', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	disk.hold();
	notes.editNote(A, titled('Typed as a note'));
	await until(() => disk.held().length === 1, 'the write to start');
	notes.open(A, 'text');
	cleanup.push(observe(notes, A));
	await Bun.sleep(5);
	expect(notes.queryClient.getQueryData(notesKeys.text(A))).toBeUndefined();
	disk.release({ all: true });
	await quiet(notes);
	const opened = notes.queryClient.getQueryData<{
		kind: string;
		file: { text: string };
	}>(notesKeys.text(A));
	expect(opened?.file.text).toContain('title: Typed as a note');
	// Its text writes on top of what the note wrote, with no conflict.
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

test('a list action is an edit like any other, written at once', async () => {
	const { notes, disk, failures } = await open();
	expect(notes.trashNote(B)).toBeUndefined();
	await quiet(notes);
	expect(disk.text(B)).toMatch(/deletedAt: "?\d{4}-/);
	expect(notes.restoreNote(B)).toBeUndefined();
	expect(notes.patchNote(B, { pinned: true })).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(B)).toContain('deletedAt: null');
	expect(disk.text(B)).toContain('pinned: true');
});

test('a new note is created in the folder shown and opened', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = foldersOf(
		notes.queryClient.getQueryData(notesKeys.rows('folders')) ?? [],
	);
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
	const [work] = foldersOf(
		notes.queryClient.getQueryData(notesKeys.rows('folders')) ?? [],
	);
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
});

test('a folder is not deleted while a note cannot say which folder it is in', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = foldersOf(
		notes.queryClient.getQueryData(notesKeys.rows('folders')) ?? [],
	);
	if (work === undefined) throw new Error('No folder');
	disk.put('notes/c.md', 'no frontmatter\n');
	await notes.refresh();
	await quiet(notes);
	expect(await notes.deleteFolder(work)).toContain('c.md');
	expect(disk.text(work.path)).toBeDefined();
});

test('a folder name is an edit to its row, written at once', async () => {
	const { notes, disk, failures } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = foldersOf(
		notes.queryClient.getQueryData(notesKeys.rows('folders')) ?? [],
	);
	if (work === undefined) throw new Error('No folder');
	expect(notes.patchFolder(work.path, { name: 'Play' })).toBeUndefined();
	await quiet(notes);
	expect(failures).toEqual([]);
	expect(disk.text(work.path)).toContain('name: Play');
});

// ============================================================================
// Rename and delete
// ============================================================================

test('a rename runs after the queued writes and moves what they saved; the open note follows it', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	const opening = notes.selected;
	if (opening === undefined) throw new Error('Nothing opened');
	disk.hold();
	notes.editNote(A, bodied('Before the rename.\n'));
	await until(() => disk.held().length === 1, 'the write to start');
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
		['NOTES~1', '"~" followed by a digit'],
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

test('a delete runs after the queued writes and removes what they saved', async () => {
	const { notes, disk, failures } = await open();
	notes.open(A);
	const deletion = expectOk(await notes.deletionFor(A));
	expect(deletion).toMatchObject({ kind: 'file', title: 'Alpha' });
	// Typed while the confirmation is open: written, then deleted.
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

test('Save version waits for writes still running, and records what they saved', async () => {
	const { notes, disk } = await open();
	disk.hold();
	notes.editNote(A, titled('In flight'));
	await until(() => disk.held().length === 1, 'the write to start');
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

test('the close fence stops edits and actions until it is released', async () => {
	const { notes, disk } = await open();
	const before = disk.text(A);
	const release = notes.fenceInput();
	expect(notes.editNote(A, titled('Typed while closing'))).toContain('closing');
	expect(cached(notes, 'a').row.fields.title).toBe('Alpha');
	expect(await notes.createNote()).toContain('closing');
	expect(notes.noteBody(A).locked).toBe(true);
	await notes.settle();
	expect(disk.text(A)).toBe(before);
	release();
	expect(notes.noteBody(A).locked).toBe(false);
	expect(notes.editNote(A, titled('After'))).toBeUndefined();
	await quiet(notes);
	expect(disk.text(A)).toContain('title: After');
});

test('close waits for a running write, every call shares one completion, and nothing starts after', async () => {
	const { notes, disk, closing } = await open();
	closing();
	disk.hold();
	notes.editNote(A, bodied('Last words.\n'));
	await until(() => disk.held().length === 1, 'the write to start');
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
	disk.release({ all: true });
	await first;
	expect(disk.text(A)).toContain('Last words.\n');
});

test('close waits for a whole folder delete, not only the write running when it began', async () => {
	const { notes, disk, closing } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	await quiet(notes);
	const [work] = foldersOf(
		notes.queryClient.getQueryData(notesKeys.rows('folders')) ?? [],
	);
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
