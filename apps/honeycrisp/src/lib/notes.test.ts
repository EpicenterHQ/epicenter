/**
 * Notes State Tests
 *
 * Drives the real notes state against Honeycrisp's real browser folder over
 * the folder package's in-memory OPFS stand-in. Another program's writes and
 * removals go below the folder's API (`put`, `drop`), so the app sees them
 * only when it reads or saves.
 *
 * Key behaviors:
 * - Opening a note writes nothing; each edit saves at once, and rapid edits
 *   write only the latest draft
 * - A change made elsewhere is a conflict: Reload theirs shows it, Keep mine
 *   saves the draft over it, and nothing is written until the person chooses
 * - A note deleted elsewhere is a conflict too: Keep mine creates it again,
 *   Discard closes it
 * - A draft that is not a valid row is never written
 * - A note whose text is not a valid row is named for repair, opens as text,
 *   saves as typed, and opens as a note once repaired
 * - Returning to the window lists again and never replaces an open note's
 *   draft
 * - Leaving a note whose save failed answers `unsaved` until it is discarded
 * - List actions go into the open note's draft, and are otherwise guarded by
 *   the version the list read
 * - Rename and delete wait for the open note's saves and act on what it
 *   saved last; a refused delete shows the file again in a new session
 * - Close waits for a whole action, such as a folder delete, not only the
 *   write running when it began
 * - Closing flushes: the held autosave snapshot lands, a hung save cannot
 *   hold the close past its bound, and a draft whose save failed does not
 *   hold it at all
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	type FlushOutcome,
	flushOnClose,
	type HostCloseSignal,
} from '@epicenter/svelte/flush-on-close';
import {
	type NotesFolderFixture,
	noteText,
	openNotesFolder,
	until,
} from './folder.test-support.js';
import type { Notes } from './notes.svelte.js';

const { createNotes } = await import('./notes.svelte.ts');

const A = 'notes/a.md';
const B = 'notes/b.md';

const opened: Notes[] = [];
afterEach(async () => {
	for (const notes of opened.splice(0)) await notes.close();
});

/** The notes state over a fresh folder holding notes `a` and `b`. */
async function open(): Promise<{ notes: Notes; disk: NotesFolderFixture }> {
	const disk = await openNotesFolder();
	await disk.write(A, noteText({ title: 'Alpha', body: 'One.\n' }));
	await disk.write(B, noteText({ title: 'Beta', body: 'Two.\n' }));
	const notes = createNotes(disk.host);
	opened.push(notes);
	await notes.check();
	return { notes, disk };
}

function noteSession(notes: Notes) {
	const item = notes.opened;
	if (item?.kind !== 'note')
		throw new Error(`Expected an open note, got ${item?.kind}`);
	return item.session;
}

function textSession(notes: Notes) {
	const item = notes.opened;
	if (item?.kind !== 'text')
		throw new Error(`Expected open text, got ${item?.kind}`);
	return item.session;
}

async function openNote(notes: Notes, path = A) {
	expect((await notes.open(path)).kind).toBe('done');
	return noteSession(notes);
}

const writesTo = (disk: NotesFolderFixture, path: string) =>
	disk.writes().filter((at) => at === path).length;

// ============================================================================
// Saving an open note
// ============================================================================

test('opening a note writes nothing, and each edit saves at once', async () => {
	const { notes, disk } = await open();
	const before = disk.text(A);
	const start = writesTo(disk, A);
	const session = await openNote(notes);
	expect(writesTo(disk, A)).toBe(start);
	expect(disk.text(A)).toBe(before);
	session.edit((row) => {
		row.fields.title = 'Alpha!';
	});
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('Alpha!');
});

test('rapid typing writes only the latest draft', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.hold();
	session.edit((row) => {
		row.body = 'O\n';
	});
	await until(() => disk.held().length === 1, 'the first write to start');
	for (const body of ['On\n', 'One\n', 'One more\n', 'One more time\n'])
		session.edit((row) => {
			row.body = body;
		});
	expect(session.state.status).toBe('saving');
	const before = writesTo(disk, A);
	disk.release({ all: true });
	expect((await session.settled()).status).toBe('saved');
	// The held write, then one write of the latest draft.
	expect(writesTo(disk, A) - before).toBe(1);
	expect(disk.text(A)).toContain('One more time\n');
	expect(session.draft.body).toBe('One more time\n');
});

test('a draft that is not a valid row is never written, and the next valid edit saves', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const before = disk.text(A);
	const start = writesTo(disk, A);
	session.edit((row) => {
		(row.fields as { pinned: unknown }).pinned = 'maybe';
	});
	const settled = await session.settled();
	expect(settled.status === 'error' && settled.error.name).toBe(
		'InvalidValues',
	);
	expect(writesTo(disk, A)).toBe(start);
	expect(disk.text(A)).toBe(before);
	session.edit((row) => {
		row.fields.pinned = true;
	});
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('pinned: true');
});

test('a failed save keeps the draft, and Try again saves it', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.failWrites();
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await session.settled()).status).toBe('error');
	expect(session.draft.body).toBe('Mine.\n');
	expect(notes.notSaved).toBe(1);
	disk.failWrites(false);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('Mine.\n');
	expect(notes.notSaved).toBe(0);
});

// ============================================================================
// Conflicts
// ============================================================================

test('a change made elsewhere is a conflict; Reload theirs shows it without writing', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.put(A, noteText({ title: 'Theirs', body: 'Theirs.\n' }));
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	const settled = await session.settled();
	expect(settled.status === 'error' && settled.error.name).toBe('Conflict');
	const generation = session.generation;
	expect(await notes.reloadTheirs(session)).toBeUndefined();
	expect(session.draft.fields.title).toBe('Theirs');
	expect(session.draft.body).toBe('Theirs.\n');
	// The rich-text view remounts on this.
	expect(session.generation).toBe(generation + 1);
	expect(session.state.status).toBe('saved');
	expect(disk.text(A)).toContain('Theirs.\n');
});

test('Keep mine saves the draft over a change made elsewhere', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.put(A, noteText({ title: 'Theirs', body: 'Theirs.\n' }));
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await session.settled()).status).toBe('error');
	expect(await notes.keepMine(session)).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('Mine.\n');
	expect(disk.text(A)).toContain('Alpha');
});

test('a note deleted elsewhere: Keep mine creates it again from the draft', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.drop(A);
	session.edit((row) => {
		row.body = 'Still mine.\n';
	});
	const settled = await session.settled();
	expect(
		settled.status === 'error' &&
			settled.error.name === 'Conflict' &&
			settled.error.actualSha256,
	).toBeUndefined();
	expect(disk.text(A)).toBeUndefined();
	expect(await notes.keepMine(session)).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('Still mine.\n');
	expect(notes.notes.some((note) => note.path === A)).toBe(true);
});

test('a note deleted elsewhere: Discard closes it without writing', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.drop(A);
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	await session.settled();
	expect(await notes.reloadTheirs(session)).toBeUndefined();
	expect(notes.opened).toBeUndefined();
	expect(disk.text(A)).toBeUndefined();
	expect(notes.notes.some((note) => note.path === A)).toBe(false);
});

test('Reload theirs of a note made invalid elsewhere opens its text for repair', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.put(A, '---\ntitle: [broken\n---\nTheirs.\n');
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	await session.settled();
	expect(await notes.reloadTheirs(session)).toBeUndefined();
	expect(textSession(notes).draft).toBe('---\ntitle: [broken\n---\nTheirs.\n');
});

test('returning to the window lists again and an idle open note takes the newer file', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const generation = session.generation;
	disk.put(A, noteText({ title: 'Theirs' }));
	disk.put('notes/c.md', noteText({ title: 'Gamma' }));
	await notes.check();
	expect(notes.notes.some((note) => note.path === 'notes/c.md')).toBe(true);
	expect(noteSession(notes)).toBe(session);
	expect(session.draft.fields.title).toBe('Theirs');
	// The rich-text editor remounts on the new generation.
	expect(session.generation).toBe(generation + 1);
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await session.settled()).status).toBe('saved');
});

// ============================================================================
// Repair as text
// ============================================================================

test('an invalid note is named for repair, opens as text, saves as typed, and reopens as a note', async () => {
	const { notes, disk } = await open();
	const broken = '---\ntitle: Gamma\npinned: maybe\n---\nBody.\n';
	await disk.write('notes/c.md', broken);
	await notes.check();
	expect(notes.repairs.map((repair) => repair.path)).toEqual(['notes/c.md']);
	expect((await notes.open('notes/c.md')).kind).toBe('done');
	const text = textSession(notes);
	expect(text.draft).toBe(broken);
	const repaired = noteText({ title: 'Gamma', body: 'Body.\n' });
	text.input(repaired);
	expect((await text.settled()).status).toBe('saved');
	expect(disk.text('notes/c.md')).toBe(repaired);
	expect((await notes.open('notes/c.md', { as: 'note' })).kind).toBe('done');
	expect(noteSession(notes).draft.fields.title).toBe('Gamma');
	await notes.refresh();
	expect(notes.repairs).toEqual([]);
});

test('a note opens as its file and back, with one read each way', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	session.edit((row) => {
		row.body = 'Edited.\n';
	});
	expect((await notes.open(A, { as: 'text' })).kind).toBe('done');
	// The edit saved before the note was let go, and the text is the file's.
	expect(textSession(notes).draft).toBe(disk.text(A) as string);
	expect(textSession(notes).draft).toContain('Edited.\n');
	expect(session.locked).toBe(true);
	expect((await notes.open(A, { as: 'note' })).kind).toBe('done');
	expect(noteSession(notes).draft.body).toBe('Edited.\n');
});

// ============================================================================
// Leaving and list actions
// ============================================================================

test('leaving a note whose save failed answers unsaved until the person discards it', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.failWrites();
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await notes.open(B)).kind).toBe('unsaved');
	expect(noteSession(notes)).toBe(session);
	expect(notes.unsettled).toBe(1);
	disk.failWrites(false);
	expect((await notes.open(B, { discard: session })).kind).toBe('done');
	expect(noteSession(notes).path).toBe(B);
	expect(session.locked).toBe(true);
	expect(disk.text(A)).not.toContain('Mine.');
});

test('opening the open note again changes nothing, even when its save failed', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	expect(await notes.open(A)).toEqual({ kind: 'done', left: false });
	expect(noteSession(notes)).toBe(session);
	disk.failWrites();
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await session.settled()).status).toBe('error');
	// Not a discard prompt: the note is already open.
	expect(await notes.open(A)).toEqual({ kind: 'done', left: false });
	expect(noteSession(notes)).toBe(session);
	expect(session.draft.body).toBe('Mine.\n');
});

test('a discard after Reload theirs reopened the item applies to the session the open answered', async () => {
	const { notes, disk } = await open();
	const before = await openNote(notes);
	disk.put(A, '---\ntitle: [broken\n---\nTheirs.\n');
	before.edit((row) => {
		row.body = 'Mine.\n';
	});
	await before.settled();
	expect(await notes.reloadTheirs(before)).toBeUndefined();
	const text = textSession(notes);
	disk.failWrites();
	text.input('---\ntitle: [still broken\n---\nMine.\n');
	expect((await text.settled()).status).toBe('error');
	const opening = await notes.open(B);
	if (opening.kind !== 'unsaved')
		throw new Error(`Expected unsaved, got ${opening.kind}`);
	expect(opening.session).toBe(text);
	// The session from before the swap discards nothing.
	expect((await notes.open(B, { discard: before })).kind).toBe('unsaved');
	disk.failWrites(false);
	expect((await notes.open(B, { discard: opening.session })).kind).toBe('done');
	expect(noteSession(notes).path).toBe(B);
});

test('Try again on a file that did not open reads it again', async () => {
	const { notes, disk } = await open();
	expect((await notes.open('notes/c.md')).kind).toBe('done');
	expect(notes.opened?.kind).toBe('failed');
	await disk.write('notes/c.md', noteText({ title: 'Gamma' }));
	expect((await notes.open('notes/c.md')).kind).toBe('done');
	expect(noteSession(notes).draft.fields.title).toBe('Gamma');
});

test('a list action on the open note is an edit to its draft', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	expect(await notes.patchNote(A, { pinned: true })).toBeUndefined();
	expect(session.draft.fields.pinned).toBe(true);
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('pinned: true');
});

test('a list action on a closed note is guarded by the version the list read', async () => {
	const { notes, disk } = await open();
	expect(await notes.trashNote(B)).toBeUndefined();
	expect(disk.text(B)).toMatch(/deletedAt: "?\d{4}-/);
	disk.put(B, noteText({ title: 'Changed elsewhere' }));
	expect(await notes.patchNote(B, { pinned: true })).toContain(
		'changed elsewhere',
	);
	expect(disk.text(B)).toBe(noteText({ title: 'Changed elsewhere' }));
	// The list read it again; the next action applies.
	expect(await notes.patchNote(B, { pinned: true })).toBeUndefined();
	expect(disk.text(B)).toContain('Changed elsewhere');
	expect(disk.text(B)).toContain('pinned: true');
});

test('deleting a folder moves its notes out first, the open one through its draft', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	const folder = notes.folders[0];
	if (folder === undefined) throw new Error('No folder');
	expect(await notes.patchNote(B, { folderId: folder.stem })).toBeUndefined();
	const session = await openNote(notes);
	session.edit((row) => {
		row.fields.folderId = folder.stem;
	});
	expect(await notes.deleteFolder(folder)).toBeUndefined();
	expect(session.draft.fields.folderId).toBeNull();
	expect(disk.text(folder.path)).toBeUndefined();
	expect(disk.text(A)).toContain('folderId: null');
	expect(disk.text(B)).toContain('folderId: null');
	expect(notes.folders).toEqual([]);
});

test('a folder is not deleted while a note cannot say which folder it is in', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	const folder = notes.folders[0];
	if (folder === undefined) throw new Error('No folder');
	await disk.write('notes/c.md', 'no frontmatter\n');
	await notes.check();
	expect(await notes.deleteFolder(folder)).toContain('c.md');
	expect(disk.text(folder.path)).toBeDefined();
});

test('a new note is created in the folder shown and opened', async () => {
	const { notes, disk } = await open();
	expect(await notes.createNote()).toBeUndefined();
	const session = noteSession(notes);
	expect(session.draft.fields.title).toBe('');
	expect(disk.text(session.path)).toBeDefined();
	expect(notes.notes.some((note) => note.path === session.path)).toBe(true);
});

// ============================================================================
// Rename and delete
// ============================================================================

test('renaming the open note moves what it saved, keeps its session, and later edits save there', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	session.edit((row) => {
		row.body = 'Before the rename.\n';
	});
	expect(await notes.rename(A, 'renamed.md')).toBeUndefined();
	expect(noteSession(notes)).toBe(session);
	expect(session.path).toBe('notes/renamed.md');
	expect(disk.text(A)).toBeUndefined();
	expect(disk.text('notes/renamed.md')).toContain('Before the rename.\n');
	session.edit((row) => {
		row.body = 'After.\n';
	});
	expect((await session.settled()).status).toBe('saved');
	expect(disk.text('notes/renamed.md')).toContain('After.\n');
	expect(await notes.rename('notes/renamed.md', 'plain.txt')).toContain('.md');
});

test('deleting the open note waits for its saves and removes what it saved last', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const { data: deletion } = await notes.deletionFor(A);
	if (deletion === null) throw new Error('No deletion');
	expect(deletion).toMatchObject({ kind: 'file', title: 'Alpha' });
	// Typed while the confirmation is open: saved, then deleted.
	session.edit((row) => {
		row.body = 'Typed during the dialog.\n';
	});
	expect(await notes.remove(deletion)).toBeUndefined();
	expect(disk.text(A)).toBeUndefined();
	expect(notes.opened).toBeUndefined();
	expect(session.locked).toBe(true);
});

test('a delete is refused when the file changed elsewhere after it was confirmed', async () => {
	const { notes, disk } = await open();
	const { data: deletion } = await notes.deletionFor(B);
	if (deletion === null) throw new Error('No deletion');
	disk.put(B, noteText({ title: 'Changed' }));
	expect(await notes.remove(deletion)).toContain('changed elsewhere');
	expect(disk.text(B)).toBe(noteText({ title: 'Changed' }));
});

test('a refused delete of the open note shows the file again in a new session that saves', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const { data: deletion } = await notes.deletionFor(A);
	if (deletion === null) throw new Error('No deletion');
	disk.put(A, noteText({ title: 'Changed elsewhere', body: 'Theirs.\n' }));
	expect(await notes.remove(deletion)).toContain('changed elsewhere');
	expect(disk.text(A)).toContain('Changed elsewhere');
	const reopened = noteSession(notes);
	expect(reopened).not.toBe(session);
	expect(reopened.draft.fields.title).toBe('Changed elsewhere');
	reopened.edit((row) => {
		row.body = 'Mine after all.\n';
	});
	expect((await reopened.settled()).status).toBe('saved');
	expect(disk.text(A)).toContain('Mine after all.\n');
});

test('close waits for a whole folder delete, not only the write running when it began', async () => {
	const { notes, disk } = await open();
	expect(await notes.createFolder('Work')).toBeUndefined();
	const folder = notes.folders[0];
	if (folder === undefined) throw new Error('No folder');
	expect(await notes.patchNote(B, { folderId: folder.stem })).toBeUndefined();
	disk.hold();
	const deleting = notes.deleteFolder(folder);
	await until(() => disk.held().length === 1, 'the note to start moving out');
	const closing = notes.close();
	opened.splice(opened.indexOf(notes), 1);
	disk.release({ all: true });
	expect(await deleting).toBeUndefined();
	await closing;
	expect(disk.text(B)).toContain('folderId: null');
	expect(disk.text(folder.path)).toBeUndefined();
});

test('close waits for a rename of a closed file, from its read through its move', async () => {
	const { notes, disk } = await open();
	disk.hold();
	const renaming = notes.rename(B, 'renamed.md');
	await until(() => disk.held().length === 1, 'the move to start writing');
	const closing = notes.close();
	opened.splice(opened.indexOf(notes), 1);
	let closed = false;
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	disk.release({ all: true });
	expect(await renaming).toBeUndefined();
	await closing;
	expect(disk.text(B)).toBeUndefined();
	expect(disk.text('notes/renamed.md')).toContain('Beta');
});

test('a refused delete after renaming the open note shows it again at its new path', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	expect(await notes.rename(A, 'renamed.md')).toBeUndefined();
	const { data: deletion } = await notes.deletionFor('notes/renamed.md');
	if (deletion === null) throw new Error('No deletion');
	disk.put('notes/renamed.md', noteText({ title: 'Changed elsewhere' }));
	expect(await notes.remove(deletion)).toContain('changed elsewhere');
	const reopened = noteSession(notes);
	expect(reopened).not.toBe(session);
	expect(reopened.path).toBe('notes/renamed.md');
	expect(reopened.draft.fields.title).toBe('Changed elsewhere');
});

// ============================================================================
// Closing
// ============================================================================

/**
 * The page's close wiring over `notes`, as `+page.svelte` makes it, with a
 * host whose one close signal the test sends. `close` answers how the flush
 * ended, as the shell's acknowledgement would follow it.
 */
function flushingOnClose(notes: Notes, ms?: number) {
	let respond: (() => Promise<FlushOutcome>) | undefined;
	const hostClose: HostCloseSignal = (run) => {
		respond = run;
		return () => {
			respond = undefined;
		};
	};
	const stop = flushOnClose(() => notes.flush(), { hostClose, ms });
	return {
		async close(): Promise<FlushOutcome> {
			await until(() => respond !== undefined, 'the close signal to listen');
			const outcome = await respond?.();
			stop();
			if (outcome === undefined) throw new Error('No close signal');
			return outcome;
		},
	};
}

test('a close sends the held snapshot and waits for it to land', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const page = flushingOnClose(notes);
	disk.hold();
	session.edit((row) => {
		row.body = 'Running.\n';
	});
	await until(() => disk.held().length === 1, 'the first write to start');
	session.edit((row) => {
		row.body = 'Held behind it.\n';
	});
	const closing = page.close();
	disk.release({ all: true });
	expect(await closing).toBe('flushed');
	expect(disk.text(A)).toContain('Held behind it.\n');
});

test('a close goes ahead within its bound when a save hangs', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const page = flushingOnClose(notes, 40);
	disk.hold();
	session.edit((row) => {
		row.body = 'Never lands.\n';
	});
	const started = performance.now();
	expect(await page.close()).toBe('timed-out');
	expect(performance.now() - started).toBeLessThan(500);
	disk.release({ all: true });
});

test('a draft whose save failed does not hold a close', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	const page = flushingOnClose(notes);
	disk.failWrites();
	session.edit((row) => {
		row.body = 'Mine.\n';
	});
	expect((await session.settled()).status).toBe('error');
	expect(await page.close()).toBe('flushed');
	// Closing never asks and takes no input away.
	expect(session.locked).toBe(false);
});

test('close waits for a running save, and a second call shares it', async () => {
	const { notes, disk } = await open();
	const session = await openNote(notes);
	disk.hold();
	session.edit((row) => {
		row.body = 'Last words.\n';
	});
	const first = notes.close();
	const second = notes.close();
	expect(second).toBe(first);
	disk.release({ all: true });
	await first;
	opened.splice(opened.indexOf(notes), 1);
	expect(disk.text(A)).toContain('Last words.\n');
});
