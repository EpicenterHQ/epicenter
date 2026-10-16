/**
 * Editing Tests
 *
 * Drives the real library and its TanStack Query cache against a real browser
 * folder over an in-memory OPFS stand-in, with a fixture capture device and
 * stubbed endpoints. Views are stood in for as they behave: an editor sends a
 * changed field as an update of the file as it is now, and a changed body
 * or text as a draft the library holds and saves over the version it
 * started from.
 *
 * Key behaviors:
 * - An update is saved; the listing takes the saved row
 * - A body typed while its save runs is saved next, from the version it
 *   wrote, so typing never conflicts with itself
 * - A read of the folder never touches a body typed: an outside change read
 *   while it is unsaved is merged with it when it saves
 * - An update over a change made elsewhere sets its field and keeps theirs
 * - A body save that fails keeps the body, and the next change saves it
 * - A recording deleted elsewhere stays deleted: its save fails, the text
 *   typed is reported, and nothing creates it again
 * - A row that is not valid is named for repair, edited as its text, and
 *   edited as fields once it reads
 * - A deletion runs after the edits are written and removes what they saved;
 *   its audio stays
 * - Nothing commits on its own; Save version records a version
 * - Close waits for an edit being written
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { folderOptions } from '@epicenter/folder/query';
import { expectOk } from 'wellcrafted/testing';
import {
	createTestStorage,
	opfsOf,
	testLocks,
} from '../../../../packages/folder/src/browser-storage.test-support.js';
import { whisperingDefinition } from './definition.js';
import { describeDeletion } from './deletion.js';
import {
	openText,
	recordingEditor,
	settle,
	transcriptEditor,
} from './edits.test-support.js';
import type { Library, WriteNotice } from './library.svelte.js';
import { holdCloses } from './opfs-holds.test-support.js';
import { createQueryClient, quiet } from './query.test-support.js';
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
 * next published `.md` write until released, `mdWrites` counts every one,
 * and `notices` collects what each write told the person.
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
	const library = createLibrary(fixture.workspace, createQueryClient());
	opened.push({ library, remove: fixture.remove });
	await library.start();
	const notices: WriteNotice[] = [];
	library.onWriteNotice((notice) => notices.push(notice));
	const faults = opfsOf(storage).faults;
	return {
		library,
		notices,
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

async function sha(library: Library, path: string) {
	return expectOk(await library.folder.files.read(path)).sha256;
}

/** Another program writes the file over whatever is there. */
async function writeElsewhere(library: Library, path: string, content: string) {
	const { files } = library.folder;
	const current = await files.read(path);
	if (current.error?.name === 'NotFound')
		return void expectOk(await files.create(path, content));
	expectOk(await files.save(expectOk(current), content, { merge: false }));
}

/** Another program deletes the file as it is now. */
async function deleteElsewhere(library: Library, path: string) {
	const { files } = library.folder;
	expectOk(await files.remove(expectOk(await files.read(path))));
}

/** Record one recording; it is saved and opens. Answers its editor. */
async function record(library: Library) {
	await library.startRecording();
	await library.stopRecording();
	expect(library.recorderError).toBeUndefined();
	await settle(library);
	return recordingEditor(library);
}

/** Transcribe the selected recording; answers its transcript's editor. */
async function transcript(library: Library) {
	const [entry] = library.entries;
	if (entry === undefined) throw new Error('Expected a recording');
	await library.transcribe(entry);
	await settle(library);
	const [result] = library.resultsFor(entry.stem);
	if (result === undefined) throw new Error('Expected a transcript');
	return transcriptEditor(library, result.path);
}

/** The listed recording at `path`, as the table shows it. */
const listed = (library: Library, path: string) =>
	library.entries.find((entry) => entry.path === path);

/** An outside change, reported as the folder's change channel reports one. */
async function reportChanged(library: Library, path: string) {
	await library.queryClient.invalidateQueries(
		folderOptions(library.folder).pathFilter([path]),
	);
	await quiet(library.queryClient);
}

/** Commits on the branch now. */
async function commits(library: Library) {
	const { data } = await library.folder.git.log(100);
	return data?.length ?? 0;
}

const recordingText = (title: string, audioPath: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: ${audioPath}\n---\n`;

// ============================================================================
// Edits and saves
// ============================================================================

test('an update is saved; the listing takes the saved row', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;

	editor.edit((row) => {
		row.fields.title = 'Morning notes';
	});
	expect(library.isSaving(editor.path)).toBe(true);
	await quiet(library.queryClient);

	expect(notices).toEqual([]);
	const written = await text(library, editor.path);
	expect(written).toContain('title: Morning notes');
	// The audio link is untouched by typing.
	expect(written).toContain(`audioPath: ${audioPath}`);
	expect(listed(library, editor.path)?.row.fields.title).toBe('Morning notes');
	expect(listed(library, editor.path)?.sha256).toBe(
		await sha(library, editor.path),
	);
	expect(library.unsaved).toBe(false);
});

test('notes typed while a save runs are saved next, from the version it wrote', async () => {
	const { library, notices, counter, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.body = 'M\n';
	});
	await held;
	const before = counter.mdWrites;
	for (const body of ['Mo\n', 'Mor\n', 'Morning\n', 'Morning notes\n'])
		editor.edit((row) => {
			row.body = body;
		});
	expect(editor.draft.body).toBe('Morning notes\n');

	release();
	await quiet(library.queryClient);
	expect(notices).toEqual([]);
	// The held save, then one save of the newest notes.
	expect(counter.mdWrites - before).toBe(1);
	expect(await text(library, editor.path)).toEndWith('---\nMorning notes\n');

	editor.edit((row) => {
		row.body = 'Morning notes, two\n';
	});
	await quiet(library.queryClient);
	expect(notices).toEqual([]);
	expect(await text(library, editor.path)).toEndWith(
		'---\nMorning notes, two\n',
	);
});

test('a read never touches notes typed, and their save merges with the change it read', async () => {
	const { library, notices, failNextWrite } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	// A save that fails keeps the notes unsaved.
	failNextWrite(editor.path);
	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await quiet(library.queryClient);
	expect(notices).toMatchObject([{ kind: 'failed', lost: undefined }]);
	expect(library.unsaved).toBe(true);

	// Another program changes the title, and the folder reports it.
	await writeElsewhere(
		library,
		editor.path,
		recordingText('Theirs', audioPath),
	);
	await reportChanged(library, editor.path);
	// The listing reads the file; the notes typed are untouched.
	expect(listed(library, editor.path)?.row.fields.title).toBe('Theirs');
	expect(editor.draft.body).toBe('Mine.\n');

	// The next change saves the notes over the version they started from.
	editor.edit((row) => {
		row.body = 'Mine, again.\n';
	});
	await quiet(library.queryClient);
	const written = await text(library, editor.path);
	expect(written).toContain('title: Theirs');
	expect(written).toEndWith('---\nMine, again.\n');
	expect(library.unsaved).toBe(false);
	expect(notices).toHaveLength(1);
});

test('an update over a change made elsewhere sets its field and keeps theirs', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	await writeElsewhere(
		library,
		editor.path,
		`${recordingText('Theirs', audioPath)}Their notes.\n`,
	);

	editor.edit((row) => {
		row.fields.title = 'Mine';
	});
	await quiet(library.queryClient);
	const written = await text(library, editor.path);
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('---\nTheir notes.\n');
	// An update replaces only what it names, so there is nothing to report.
	expect(notices).toEqual([]);
	expect(library.saving).toBe(false);
});

test('the folder refuses a value it cannot hold, and the file stays as it was', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const saved = await text(library, editor.path);
	// Inputs commit only values the schema accepts; this bypasses them.
	editor.edit((row) => {
		(row.fields as { durationMs: unknown }).durationMs = 'long';
	});
	await quiet(library.queryClient);
	expect(notices).toMatchObject([
		{ kind: 'failed', error: { name: 'InvalidValues' } },
	]);
	expect(await text(library, editor.path)).toBe(saved);
	expect(listed(library, editor.path)?.row.fields.durationMs).toBe(1000);
});

test('a recording deleted elsewhere stays deleted: its save fails, nothing creates it again, and the text typed is reported', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	await deleteElsewhere(library, path);

	editor.edit((row) => {
		row.body = 'Typed after it was deleted.\n';
	});
	await settle(library);

	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({
		kind: 'failed',
		path,
		error: { name: 'NotFound' },
	});
	expect(notices[0]?.kind === 'failed' && notices[0].lost).toContain(
		'Typed after it was deleted.',
	);
	expect(await text(library, path)).toBeUndefined();
	// The listing read it gone: the table and the detail show it gone.
	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
	expect(library.unsaved).toBe(false);
	// Its audio is an ordinary file, left where it was.
	expect((await library.folder.files.read(audioPath)).error).toBeNull();

	// A later edit has no row to change, and writes nothing.
	library.editBody(
		'recordings',
		path.slice('recordings/'.length, -3),
		'Still typing.\n',
	);
	void library.saveBody(path);
	await settle(library);
	expect(await text(library, path)).toBeUndefined();
	expect(notices).toHaveLength(1);
});

test('a transcript deleted elsewhere stays deleted too', async () => {
	const { library, notices } = await open();
	await record(library);
	const editor = await transcript(library);
	await deleteElsewhere(library, editor.path);

	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(library);
	expect(notices).toMatchObject([{ kind: 'failed', path: editor.path }]);
	expect(notices[0]?.kind === 'failed' && notices[0].lost).toContain('Mine.');
	expect(await text(library, editor.path)).toBeUndefined();
	expect(library.transcriptions).toEqual([]);
});

// ============================================================================
// Repair and Source
// ============================================================================

test('a row that is not valid is named for repair, is written as typed text, and reads as fields once repaired', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	const broken = `---\ntitle: Broken\naudioPath: ${audioPath}\n---\n`;
	await writeElsewhere(library, path, broken);
	await settle(library);

	expect(library.repairs.map((item) => item.path)).toEqual([path]);
	expect(library.showsText(path)).toBe(true);
	const source = await openText(library, path);
	expect(source.draft).toBe(broken);
	expect(await library.useForm(path)).toContain('does not read');

	source.input(recordingText('Repaired', audioPath));
	expect(source.draft).toBe(recordingText('Repaired', audioPath));
	await settle(library);
	expect(notices).toEqual([]);
	expect(await text(library, path)).toBe(recordingText('Repaired', audioPath));
	expect(library.repairs).toEqual([]);
	expect(await library.useForm(path)).toBeUndefined();
	expect(library.showsText(path)).toBe(false);
	expect(recordingEditor(library).draft.fields.title).toBe('Repaired');
});

test('text typed over a file changed elsewhere merges with it, says what it replaced, and restores theirs', async () => {
	const { library, notices } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	expect(await library.editSource(path)).toBeUndefined();
	const source = await openText(library, path);
	const theirs = recordingText('Theirs', audioPath);
	await writeElsewhere(library, path, theirs);

	source.input(recordingText('Mine', audioPath));
	await settle(library);
	// Both changed the title: the typing's stands, and theirs is named.
	expect(notices).toMatchObject([
		{
			kind: 'replaced',
			path,
			replaced: [{ kind: 'field', kept: 'Mine', theirs: 'Theirs' }],
		},
	]);
	// A merged row is written in its standard form.
	const merged = (await text(library, path)) ?? '';
	expect(merged).toContain('title: Mine\n');
	expect(source.draft).toBe(merged);

	const notice = notices[0];
	if (notice?.kind !== 'replaced') throw new Error('nothing was replaced');
	notice.restore();
	await settle(library);
	expect(await text(library, path)).toBe(merged.replace('Mine', 'Theirs'));
});

test('Source edits a valid row as its exact text, after the fields it was typed in are written', async () => {
	const { library, notices, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.body = 'Typed in the fields.\n';
	});
	await held;
	const opening = library.editSource(path);
	release();
	expect(await opening).toBeUndefined();
	expect(library.showsText(path)).toBe(true);
	const source = await openText(library, path);
	expect(source.draft).toEndWith('---\nTyped in the fields.\n');

	source.input(source.draft.replace('Typed in the fields.', 'Typed as text.'));
	await settle(library);
	expect(notices).toEqual([]);
	expect(await text(library, path)).toEndWith('---\nTyped as text.\n');
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingEditor(library).draft.body).toBe('Typed as text.\n');
});

// ============================================================================
// Deleting
// ============================================================================

test('a deletion runs after the edits are written and removes the recording and its results, keeping its audio', async () => {
	const { library, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	const result = await transcript(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Saved before the delete';
	});
	await held;
	const capturing = library.deletionFor(path);
	release();
	const deletion = expectOk(await capturing);
	expect(deletion).toMatchObject({
		kind: 'recording',
		title: 'Saved before the delete',
		audioPath,
		results: [{ path: result.path }],
		// Nothing is in a saved version yet.
		unversioned: true,
	});
	expect(describeDeletion(deletion).description).toContain(
		'changes that are in no saved version',
	);

	// Typed while the dialog is open: written, and the delete removes that.
	editor.edit((row) => {
		row.body = 'Typed while asked.\n';
	});
	expect(await library.remove(deletion)).toBeUndefined();
	expect(await text(library, path)).toBeUndefined();
	expect(await text(library, result.path)).toBeUndefined();
	expect((await library.folder.files.read(audioPath)).error).toBeNull();
	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
});

test('a deletion is refused when the file changed elsewhere after it was confirmed', async () => {
	const { library } = await open();
	const editor = await record(library);
	const { path } = editor;
	const deletion = expectOk(await library.deletionFor(path));
	const theirs = recordingText('Changed', editor.draft.fields.audioPath);
	await writeElsewhere(library, path, theirs);

	expect(await library.remove(deletion)).toContain('changed elsewhere');
	expect(await text(library, path)).toBe(theirs);
	await settle(library);
	expect(recordingEditor(library).draft.fields.title).toBe('Changed');
});

// ============================================================================
// Versions and closing
// ============================================================================

test('nothing commits on its own: edits are written with no commit, and Save version records one', async () => {
	const { library } = await open();
	const editor = await record(library);
	await transcript(library);
	const before = await commits(library);

	for (const title of ['One', 'Two', 'Three']) {
		editor.edit((row) => {
			row.fields.title = title;
		});
		await settle(library);
	}
	expect(await text(library, editor.path)).toContain('title: Three');
	expect(await commits(library)).toBe(before);
	expect(library.git.lastCommit).toBeUndefined();
	const status = expectOk(await library.folder.git.status());
	expect(status.changes.map((change) => change.path)).toContain(editor.path);

	const outcome = await library.saveVersion();
	expect(outcome.status).toBe('committed');
	expect(await commits(library)).toBe(before + 1);
	const [head] = expectOk(await library.folder.git.log(1));
	expect(head?.oid).toBe(outcome.status === 'committed' ? outcome.oid : '');
	expect(expectOk(await library.folder.git.status()).changes).toEqual([]);

	// Editing again commits nothing until the next Save version.
	editor.edit((row) => {
		row.fields.title = 'Four';
	});
	await settle(library);
	expect(await commits(library)).toBe(before + 1);
});

test('close waits for an edit being written, and it lands before the folder closes', async () => {
	const { library, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { path } = editor;
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed before closing';
	});
	await held;
	let closed = false;
	const closing = library.close().then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);
	// Nothing new starts once closing began.
	editor.edit((row) => {
		row.fields.title = 'Typed after closing began';
	});
	release();
	await closing;
	expect(closed).toBe(true);
	expect(library.saving).toBe(false);
	expect(library.rowAt('recordings', path)?.fields.title).toBe(
		'Typed before closing',
	);
});
