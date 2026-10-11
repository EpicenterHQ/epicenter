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
 * - A change made elsewhere to other fields merges with no question. Parts
 *   both changed become a review, and nothing more is written until the
 *   person answers it: Saved elsewhere takes theirs, Your edit saves the draft
 * - A transcript deleted elsewhere: Your edit creates it again. A recording
 *   deleted elsewhere is never restored, since its audio may be gone too:
 *   Your edit is refused, and Saved elsewhere closes it
 * - A row whose text is not a valid row opens as text with its issues, saves
 *   as typed, and opens as fields once repaired
 * - A deletion waits for the open draft's saves and deletes what the last one
 *   confirmed: the recording's row and its results; its audio stays. A draft
 *   whose save failed does not refuse it: its edits are discarded
 * - Leaving a draft whose save failed answers `unsaved` until the person
 *   discards it
 * - Returning to the window adopts a newer version of a draft that holds
 *   nothing unsaved
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
import { allFrom } from './drafts.test-support.js';
import type { Library } from './library.svelte.js';
import { holdCloses } from './opfs-holds.test-support.js';
import { openTestWorkspace } from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const opened: { library: Library; remove: () => Promise<void> }[] = [];
let count = 0;

afterEach(async () => {
	for (const { library, remove } of opened.splice(0)) {
		await library.close();
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
	opened.push({ library, remove: fixture.remove });
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

test('a failed save keeps the draft and holds the close; Try again saves it', async () => {
	const { library, failNextWrite } = await open();
	const session = await record(library);
	failNextWrite(session.path);
	session.edit((row) => {
		row.body = 'Notes kept.\n';
	});
	expect((await session.settled()).status).toBe('error');
	expect(session.draft.body).toBe('Notes kept.\n');
	expect(await library.prepareToLeave()).toBe(false);
	expect(library.unsavedWork).toContain(
		`${session.path} has edits whose last save failed.`,
	);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await text(library, session.path)).toContain('Notes kept.');
	expect(await library.prepareToLeave()).toBe(true);
});

// ============================================================================
// A change made elsewhere
// ============================================================================

/** The kind of each part of `session`'s review, and the field it names. */
function parts(session: RowSession<RecordingFields | TranscriptionFields>) {
	return session.review?.conflicts.map((conflict) =>
		conflict.kind === 'field'
			? `field:${conflict.field}`
			: conflict.kind === 'file'
				? `file:${conflict.incoming.present ? 'present' : 'deleted'}`
				: conflict.kind,
	);
}

const DELETED_HERE =
	'This file was deleted elsewhere and cannot be restored here';

test('a change made elsewhere to other parts merges with no review, and the draft shows both', async () => {
	const { library } = await open();
	const session = await record(library);
	const saved = await text(library, session.path);
	if (saved === undefined) throw new Error('Expected the recording saved');
	await writeElsewhere(library, session.path, `${saved}Their notes.\n`);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	expect((await session.settled()).status).toBe('saved');

	expect(session.review).toBeUndefined();
	expect(session.draft.fields.title).toBe('Mine');
	expect(session.draft.body).toBe('Their notes.\n');
	expect(await text(library, session.path)).toBe(
		`${saved.replace(/^title: .*$/m, 'title: Mine')}Their notes.\n`,
	);
});

test('a field both changed is a review that writes nothing, and Saved elsewhere takes theirs', async () => {
	const { library, counter } = await open();
	const session = await record(library);
	const saved = await text(library, session.path);
	if (saved === undefined) throw new Error('Expected the recording saved');
	const theirs = saved.replace(/^title: .*$/m, 'title: Theirs');
	await writeElsewhere(library, session.path, theirs);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	const state = await session.settled();
	expect(state.status === 'error' && state.error.name).toBe('Conflict');
	expect(parts(session)).toEqual(['field:title']);
	expect(await text(library, session.path)).toBe(theirs);
	const writes = counter.mdWrites;

	expect(
		await library.resolveReview(session, allFrom(session, 'incoming')),
	).toBeUndefined();
	// Theirs is what the file holds: nothing is written.
	expect(counter.mdWrites).toBe(writes);
	expect(session.review).toBeUndefined();
	expect(session.draft.fields.title).toBe('Theirs');
	expect(session.state.status).toBe('saved');
	expect(await text(library, session.path)).toBe(theirs);
});

test('Your edit saves the draft over a field changed elsewhere', async () => {
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
	expect(parts(session)).toEqual(['field:title']);

	expect(
		await library.resolveReview(session, allFrom(session, 'local')),
	).toBeUndefined();
	expect((await session.settled()).status).toBe('saved');
	expect(session.review).toBeUndefined();
	expect(await text(library, session.path)).toContain('title: Mine');
});

test('a transcript deleted elsewhere is a review of the whole file: Your edit creates it again from the draft', async () => {
	const { library } = await open();
	await record(library);
	const session = await transcript(library);
	await deleteElsewhere(library, session.path);
	session.edit((row) => {
		row.body = 'Mine, kept.\n';
	});
	await session.settled();
	expect(parts(session)).toEqual(['file:deleted']);
	expect(await text(library, session.path)).toBeUndefined();

	expect(
		await library.resolveReview(session, allFrom(session, 'local')),
	).toBeUndefined();
	expect(session.review).toBeUndefined();
	expect(await text(library, session.path)).toContain('Mine, kept.');
});

test('a recording deleted elsewhere is never restored: Your edit is refused with the reason shown, and Saved elsewhere closes it', async () => {
	const { library } = await open();
	const session = await record(library);
	const path = session.path;
	await deleteElsewhere(library, path);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(parts(session)).toEqual(['file:deleted']);

	// Its audio may be gone too, so it is not created again.
	expect(
		await library.resolveReview(session, allFrom(session, 'local')),
	).toBeDefined();
	expect(session.review?.problems.map((problem) => problem.message)).toEqual([
		DELETED_HERE,
	]);
	expect(await text(library, path)).toBeUndefined();
	expect(library.draftAt(path)).toBeDefined();

	expect(
		await library.resolveReview(session, allFrom(session, 'incoming')),
	).toBeUndefined();
	expect(library.draftAt(path)).toBeUndefined();
	expect(library.selection).toBeUndefined();
	expect(await text(library, path)).toBeUndefined();
	expect(await library.prepareToLeave()).toBe(true);
});

test('a recording deleted after its review was shown is never restored: the review becomes its deletion, and only Saved elsewhere is accepted', async () => {
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
	expect(parts(session)).toEqual(['field:title']);

	// Another writer deletes it before the person chooses.
	await deleteElsewhere(library, path);
	expect(
		await library.resolveReview(session, allFrom(session, 'local')),
	).toBeDefined();
	await session.settled();
	expect(await text(library, path)).toBeUndefined();
	expect(parts(session)).toEqual(['file:deleted']);

	expect(
		await library.resolveReview(session, allFrom(session, 'local')),
	).toBeDefined();
	expect(session.review?.problems.map((problem) => problem.message)).toEqual([
		DELETED_HERE,
	]);
	expect(await text(library, path)).toBeUndefined();

	expect(
		await library.resolveReview(session, allFrom(session, 'incoming')),
	).toBeUndefined();
	expect(library.draftAt(path)).toBeUndefined();
	expect(await text(library, path)).toBeUndefined();
});

test('a recording made invalid elsewhere: Saved elsewhere keeps that text and opens it as text with the issues', async () => {
	const { library } = await open();
	const session = await record(library);
	const invalid = '---\ntitle: [unclosed\n---\n';
	await writeElsewhere(library, session.path, invalid);
	session.edit((row) => {
		row.fields.title = 'Mine';
	});
	await session.settled();
	expect(parts(session)).toEqual(['file:present']);

	expect(
		await library.resolveReview(session, allFrom(session, 'incoming')),
	).toBeUndefined();
	const draft = library.selection?.draft;
	expect(draft?.kind).toBe('text');
	expect(draft?.kind === 'text' && draft.session.draft).toBe(invalid);
	expect(await text(library, session.path)).toBe(invalid);
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
	expect(await library.prepareToLeave()).toBe(true);
});
