/**
 * Editing Tests
 *
 * Drives the real library against a real browser folder over an in-memory
 * OPFS stand-in, with a fixture capture device and stubbed endpoints.
 *
 * Key behaviors:
 * - An open draft saves each edit at once, and rapid edits write only the
 *   latest draft
 * - A draft that is not a valid row is never written
 * - A change made elsewhere is a conflict: Reload theirs shows it, Keep mine
 *   saves the draft over it, and nothing is written until the person chooses
 * - A transcript deleted elsewhere: Keep mine creates it again. A recording
 *   deleted elsewhere offers only Discard, which closes it
 * - A row whose text is not a valid row opens as text with its issues, saves
 *   as typed, and opens as fields once repaired
 * - A deletion waits for the open draft's saves and deletes what the last one
 *   confirmed: the recording's row and its results; its audio stays. A draft
 *   whose save failed does not refuse it: its edits are discarded
 * - Leaving a draft whose save failed answers `unsaved` until the person
 *   discards it
 * - Returning to the window adopts a newer version of a draft that holds
 *   nothing unsaved
 * - Closing sends a draft's held snapshot and waits for it; a failed save is
 *   not sent again and does not hold the close
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import type { RowSession } from '@epicenter/svelte/edit-session';
import { expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import {
	type RecordingFields,
	type TranscriptionFields,
	whisperingDefinition,
} from './definition.js';
import { describeDeletion } from './deletion.js';
import type { Library } from './library.svelte.js';
import { holdCloses } from './opfs-holds.test-support.js';
import { openTestWorkspace } from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const opened: { close: () => Promise<void>; remove: () => Promise<void> }[] =
	[];
let count = 0;

afterEach(async () => {
	for (const { close, remove } of opened.splice(0)) {
		await close();
		await remove();
	}
});

/**
 * The library over a fresh browser folder. `holdNextMarkdownWrite` holds the
 * next published `.md` write until released, and `mdWrites` counts every one.
 */
async function open() {
	const storage = createTestStorage();
	let hold: PromiseWithResolvers<void> | undefined;
	let held: PromiseWithResolvers<void> | undefined;
	const counter = { mdWrites: 0 };
	const folder = expectOk(
		await openFolder({
			id: `whispering-test-${count++}`,
			definition: whisperingDefinition,
			browser: {
				author: { name: 'Test', email: 'test@example.test' },
				commitOnEdit: false,
				opfs: {
					locks: testLocks,
					getDirectory: async () =>
						holdCloses(await storage.opfs.getDirectory(), async (file) => {
							if (!file.name.endsWith('.md')) return;
							counter.mdWrites++;
							const gate = hold;
							if (gate === undefined) return;
							hold = undefined;
							held?.resolve();
							await gate.promise;
						}),
				},
			},
		}),
	);
	const fixture = await openTestWorkspace({ folder });
	const library = createLibrary(fixture.workspace);
	opened.push({ close: library.close, remove: fixture.remove });
	await library.start();
	const faults = opfsOf(storage).faults;
	return {
		library,
		counter,
		holdNextMarkdownWrite() {
			hold = Promise.withResolvers<void>();
			held = Promise.withResolvers<void>();
			return { held: held.promise, release: hold.resolve };
		},
		/** The next write of `path` fails before it publishes. */
		failNextWrite(path: string) {
			faults.write = (file) => {
				if (!file.endsWith(`/${path}`)) return undefined;
				faults.write = undefined;
				return 'fail';
			};
		},
	};
}

async function text(library: Library, path: string) {
	const read = await library.folder.files.read(path);
	return read.error ? undefined : new TextDecoder().decode(read.data.bytes);
}

/** Another program writes the file. */
async function writeElsewhere(library: Library, path: string, content: string) {
	expectOk(await library.folder.files.overwrite(path, content));
}

/** Another program deletes the file as it is now. */
async function deleteElsewhere(library: Library, path: string) {
	const { files } = library.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));
}

/** Record one recording; it is saved and opens. */
async function record(library: Library): Promise<RowSession<RecordingFields>> {
	await library.startRecording();
	await library.stopRecording();
	expect(library.pending).toEqual([]);
	return recordingSession(library);
}

function recordingSession(library: Library): RowSession<RecordingFields> {
	const draft = library.selection?.draft;
	if (draft?.kind !== 'row' || draft.table !== 'recordings')
		throw new Error(`Expected an open recording, got ${draft?.kind}`);
	return draft.session;
}

/** Transcribe the selected recording and open its transcript beside it. */
async function transcript(
	library: Library,
): Promise<RowSession<TranscriptionFields>> {
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	const result = library.resultsFor(entry.stem)[0]!;
	await library.openTranscript(result.path);
	const draft = library.draftAt(result.path);
	if (draft?.kind !== 'row' || draft.table !== 'transcriptions')
		throw new Error(`Expected an open transcript, got ${draft?.kind}`);
	return draft.session;
}

const recordingText = (title: string, audioPath: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: ${audioPath}\n---\n`;

// ============================================================================
// Saving an open draft
// ============================================================================

test('each edit saves at once, and rapid edits write only the latest draft', async () => {
	const { library, counter, holdNextMarkdownWrite } = await open();
	const session = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.fields.title = 'M';
	});
	await held;
	const before = counter.mdWrites;
	for (const title of ['Mo', 'Mor', 'Morning', 'Morning notes'])
		session.edit((row) => {
			row.fields.title = title;
		});
	expect(session.state.status).toBe('saving');
	release();
	expect((await session.settled()).status).toBe('saved');
	// The held write, then one write of the latest draft.
	expect(counter.mdWrites - before).toBe(1);
	expect(await text(library, session.path)).toContain('title: Morning notes');
	// The audio link is untouched by typing.
	expect(await text(library, session.path)).toContain(
		`audioPath: ${session.draft.fields.audioPath}`,
	);
});

test('a draft that is not a valid row is never written, and the next valid edit saves', async () => {
	const { library } = await open();
	const session = await record(library);
	const saved = await text(library, session.path);
	session.edit((row) => {
		(row.fields as { durationMs: unknown }).durationMs = 'long';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('InvalidValues');
	expect(await text(library, session.path)).toBe(saved);
	expect(library.saveProblems).toBe(1);
	session.edit((row) => {
		row.fields.durationMs = 1000;
		row.fields.title = 'Fixed';
	});
	expect((await session.settled()).status).toBe('saved');
	expect(await text(library, session.path)).toContain('title: Fixed');
});

test('a failed save keeps the draft and warns before leaving; Try again saves it', async () => {
	const { library, failNextWrite } = await open();
	const session = await record(library);
	failNextWrite(session.path);
	session.edit((row) => {
		row.body = 'Notes kept.\n';
	});
	expect((await session.settled()).status).toBe('error');
	expect(session.draft.body).toBe('Notes kept.\n');
	expect(library.holdsUnsavedWork).toBe(true);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await text(library, session.path)).toContain('Notes kept.');
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// The conflict prompt
// ============================================================================

test('a change made elsewhere is a conflict, and Reload theirs shows it without writing', async () => {
	const { library } = await open();
	const session = await record(library);
	const theirs = recordingText('Theirs', session.draft.fields.audioPath);
	await writeElsewhere(library, session.path, theirs);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(await text(library, session.path)).toBe(theirs);

	expect(await library.reloadTheirs(session)).toBeUndefined();
	expect(session.draft.fields.title).toBe('Theirs');
	expect(session.state.status).toBe('saved');
	expect(await text(library, session.path)).toBe(theirs);
});

test('Keep mine saves the draft over a change made elsewhere', async () => {
	const { library } = await open();
	const session = await record(library);
	await writeElsewhere(
		library,
		session.path,
		recordingText('Theirs', session.draft.fields.audioPath),
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(library.canKeepMine(session)).toBe(true);

	expect(await library.keepMine(session)).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(await text(library, session.path)).toContain('title: Mine');
});

test('a transcript deleted elsewhere is a conflict: Keep mine creates it again from the draft', async () => {
	const { library } = await open();
	await record(library);
	const session = await transcript(library);
	await deleteElsewhere(library, session.path);
	session.edit((row) => {
		row.body = 'Mine, kept.\n';
	});
	const state = await session.settled();
	expect(
		state.status === 'error' &&
			state.error.name === 'Conflict' &&
			state.error.actualSha256,
	).toBeUndefined();
	expect(await text(library, session.path)).toBeUndefined();

	expect(library.canKeepMine(session)).toBe(true);
	expect(await library.keepMine(session)).toBeUndefined();
	expect(await text(library, session.path)).toContain('Mine, kept.');
});

test('a recording deleted elsewhere offers only Discard, which closes it without writing', async () => {
	const { library } = await open();
	const session = await record(library);
	const path = session.path;
	await deleteElsewhere(library, path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();

	// Its audio may be gone too, so it is not created again.
	expect(library.canKeepMine(session)).toBe(false);
	expect(await library.keepMine(session)).toContain('cannot be restored');
	expect(await text(library, path)).toBeUndefined();

	expect(await library.reloadTheirs(session)).toBeUndefined();
	expect(library.draftAt(path)).toBeUndefined();
	expect(library.selection).toBeUndefined();
	expect(await text(library, path)).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
});

test('Keep mine never restores a recording deleted after its conflict was shown; only Discard is left', async () => {
	const { library } = await open();
	const session = await record(library);
	const path = session.path;
	await writeElsewhere(
		library,
		path,
		recordingText('Theirs', session.draft.fields.audioPath),
	);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	// Changed elsewhere, not deleted: Keep mine is offered.
	expect(library.canKeepMine(session)).toBe(true);

	// Another writer deletes it before the person chooses.
	await deleteElsewhere(library, path);
	expect(await library.keepMine(session)).toContain('cannot be restored');
	expect(await text(library, path)).toBeUndefined();
	expect(library.canKeepMine(session)).toBe(false);

	expect(await library.reloadTheirs(session)).toBeUndefined();
	expect(library.draftAt(path)).toBeUndefined();
	expect(await text(library, path)).toBeUndefined();
});

test('Reload theirs of a recording made invalid elsewhere opens its text with the issues', async () => {
	const { library } = await open();
	const session = await record(library);
	await writeElsewhere(library, session.path, '---\ntitle: [unclosed\n---\n');
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();

	expect(await library.reloadTheirs(session)).toBeUndefined();
	const draft = library.selection?.draft;
	expect(draft?.kind).toBe('text');
	expect(draft?.kind === 'text' && draft.session.draft).toBe(
		'---\ntitle: [unclosed\n---\n',
	);
});

// ============================================================================
// Repairing a row as text
// ============================================================================

test('a row that is not valid is named for repair, opens as text, saves as typed, and reopens as fields', async () => {
	const { library } = await open();
	const path = 'transformations/broken.md';
	const broken = '---\ntitle: Clean up\n---\nTidy it.\n';
	expectOk(await library.folder.files.create(path, broken));
	await library.refresh();
	expect(library.transformations).toEqual([]);
	expect(library.transformationRepairs).toEqual([
		expect.objectContaining({ path, reason: expect.stringContaining('model') }),
	]);

	expect(await library.open(path)).toBeUndefined();
	const draft = library.selectedTransformation?.draft;
	if (draft?.kind !== 'text')
		throw new Error(`Expected text, got ${draft?.kind}`);
	// The fields cannot open until the text reads.
	expect(await library.useForm(path)).toContain('does not read');

	const repaired =
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy it.\n';
	draft.session.input(repaired);
	expect((await draft.session.settled()).status).toBe('saved');
	expect(await text(library, path)).toBe(repaired);

	expect(await library.useForm(path)).toBeUndefined();
	const row = library.selectedTransformation?.draft;
	expect(
		row?.kind === 'row' &&
			row.table === 'transformations' &&
			row.session.draft.fields.title,
	).toBe('Clean up');
	await library.refresh();
	expect(library.transformations.map((entry) => entry.path)).toEqual([path]);
	expect(library.transformationRepairs).toEqual([]);
});

test('Source edits a valid row as its exact text, and the form returns once it reads', async () => {
	const { library } = await open();
	const session = await record(library);
	const path = session.path;
	expect(await library.editSource(path)).toBeUndefined();
	const draft = library.selection?.draft;
	if (draft?.kind !== 'text')
		throw new Error(`Expected text, got ${draft?.kind}`);
	draft.session.input(
		draft.session.draft.replace(/title: .*/, 'title: From source'),
	);
	await draft.session.settled();
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingSession(library).draft.fields.title).toBe('From source');
});

// ============================================================================
// Leaving and returning
// ============================================================================

test('opening another item waits for saves, and a failed save answers unsaved until discarded', async () => {
	const { library, failNextWrite } = await open();
	const first = await record(library);
	const firstPath = first.path;
	expectOk(await library.folder.files.create('notes.txt', 'hello'));
	failNextWrite(firstPath);
	first.edit((row) => {
		row.fields.title = 'Not saved';
	});
	await first.settled();

	const refused = await library.open('notes.txt');
	expect(refused?.unsaved).toBe(first);
	expect(library.selectedPath).toBe(firstPath);

	expect(await library.open('notes.txt', { discard: first })).toBeUndefined();
	expect(library.selectedPath).toBe('notes.txt');
	expect(library.draftAt(firstPath)).toBeUndefined();
	expect(first.locked).toBe(true);
	expect(await text(library, firstPath)).not.toContain('Not saved');
});

test('an open that a newer open of the same pane overtakes shows nothing, and the other pane keeps its draft', async () => {
	const { library } = await open();
	const recording = await record(library);
	expect(
		await library.createTransformation({ title: 'Tidy', prompt: 'Tidy.\n' }),
	).toBeUndefined();
	const transformation = library.selectedTransformation!;
	expectOk(await library.folder.files.create('notes.txt', 'notes'));
	expectOk(await library.folder.files.create('other.txt', 'other'));

	// Both leave the recording; the later one takes the recordings pane.
	const first = library.open('notes.txt');
	const second = library.open('other.txt');
	expect(await first).toBeUndefined();
	expect(await second).toBeUndefined();
	expect(library.selectedPath).toBe('other.txt');
	expect(library.draftAt('other.txt')?.kind).toBe('text');
	expect(library.draftAt('notes.txt')).toBeUndefined();
	expect(library.draftAt(recording.path)).toBeUndefined();
	expect(recording.locked).toBe(true);

	// A load still running when its pane opens something else installs nothing.
	const loading = library.open('notes.txt');
	await Bun.sleep(0);
	await library.open(recording.path);
	await loading;
	expect(library.selectedPath).toBe(recording.path);
	expect(library.draftAt('notes.txt')).toBeUndefined();
	expect(library.draftAt('other.txt')).toBeUndefined();

	// The transformations pane was never left.
	expect(library.selectedTransformation?.draft).toBe(transformation.draft);
	expect(library.draftAt(transformation.path)).toBe(transformation.draft);
});

test('returning adopts a newer version of an open draft that holds nothing unsaved', async () => {
	const { library } = await open();
	const session = await record(library);
	await writeElsewhere(
		library,
		session.path,
		recordingText('From elsewhere', session.draft.fields.audioPath),
	);
	await library.check();
	expect(session.draft.fields.title).toBe('From elsewhere');
	expect(session.state.status).toBe('saved');
});

// ============================================================================
// Deleting
// ============================================================================

test('a deletion waits for the open draft’s saves and removes the recording and its results, keeping its audio', async () => {
	const { library, holdNextMarkdownWrite } = await open();
	const session = await record(library);
	const audioPath = session.draft.fields.audioPath;
	const result = await transcript(library);
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.fields.title = 'Saved before the delete';
	});
	await held;
	const capturing = library.deletionFor(session.path);
	release();
	const deletion = expectOk(await capturing);
	expect(deletion).toMatchObject({
		kind: 'recording',
		title: 'Saved before the delete',
		audioPath,
		results: [{ path: result.path }],
	});

	// Typed while the dialog is open: saved, and the delete removes that.
	session.edit((row) => {
		row.body = 'Typed while asked.\n';
	});
	expect(await library.remove(deletion)).toBeUndefined();
	expect(session.locked).toBe(true);
	expect(await text(library, session.path)).toBeUndefined();
	expect(await text(library, result.path)).toBeUndefined();
	expect((await library.folder.files.read(audioPath)).error).toBeNull();
	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
});

test('a deletion is refused when the file changed after it was confirmed, and the file opens as it is', async () => {
	const { library } = await open();
	const session = await record(library);
	const path = session.path;
	const deletion = expectOk(await library.deletionFor(path));
	const theirs = recordingText('Changed', session.draft.fields.audioPath);
	await writeElsewhere(library, path, theirs);

	expect(await library.remove(deletion)).toContain('changed elsewhere');
	expect(await text(library, path)).toBe(theirs);
	expect(recordingSession(library).draft.fields.title).toBe('Changed');
});

test('a draft whose save failed does not refuse the deletion: it removes what was last saved and discards the edits', async () => {
	const { library, failNextWrite } = await open();
	const session = await record(library);
	const path = session.path;
	failNextWrite(path);
	session.edit((row) => {
		row.fields.title = 'Not saved';
	});
	expect((await session.settled()).status).toBe('error');

	const deletion = expectOk(await library.deletionFor(path));
	expect(deletion).toMatchObject({ kind: 'recording', row: { path } });
	expect(describeDeletion(deletion).description).toContain(
		'Edits here that are not saved are discarded too.',
	);
	expect(await library.remove(deletion)).toBeUndefined();
	expect(session.locked).toBe(true);
	expect(await text(library, path)).toBeUndefined();
	expect(library.draftAt(path)).toBeUndefined();
	expect(library.selection).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// Closing the app
// ============================================================================

test('closing sends a draft’s held snapshot and waits for it to land', async () => {
	const { library, holdNextMarkdownWrite, counter } = await open();
	const session = await record(library);
	const before = counter.mdWrites;
	const { held, release } = holdNextMarkdownWrite();
	session.edit((row) => {
		row.body = 'First.\n';
	});
	await held;
	// Typed while the first write runs: held as a snapshot, not yet sent.
	session.edit((row) => {
		row.body = 'Typed just before quitting.\n';
	});

	let closed = false;
	const closing = library.close().then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);

	release();
	await closing;
	expect(counter.mdWrites - before).toBe(2);
	expect(session.state.status).toBe('saved');
	expect(session.draft.body).toBe('Typed just before quitting.\n');
});

test('a draft whose save failed does not hold the close, and is not saved again', async () => {
	const { library, failNextWrite, counter } = await open();
	const session = await record(library);
	failNextWrite(session.path);
	session.edit((row) => {
		row.body = 'Lost on quit.\n';
	});
	expect((await session.settled()).status).toBe('error');
	const writes = counter.mdWrites;

	await library.close();
	// Nothing retried it: the save bar already said it failed.
	expect(counter.mdWrites).toBe(writes);
	expect(session.state.status).toBe('error');
});
