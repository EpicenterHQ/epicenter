/**
 * Editing Tests
 *
 * Drives the real library and its TanStack Query cache against a real browser
 * folder over an in-memory OPFS stand-in, with a fixture capture device and
 * stubbed endpoints. Views are stood in for as they behave: an editor changes
 * the row or text in the cache, which queues the file's write.
 *
 * Key behaviors:
 * - An edit changes the cache at once and is written to the file at once
 * - Rapid edits run one write at a time per file, with one waiting; the
 *   waiting write saves the newest row, guarded by the hash the previous one
 *   confirmed, so typing never conflicts with itself
 * - No read starts while a write runs: not on returning to the window, not
 *   on Check again, not when a view mounts
 * - A write that meets a change made elsewhere, or fails, rolls back to the
 *   file and reports the text that was lost; the write waiting behind it
 *   saves the file as it is
 * - A recording deleted elsewhere stays deleted: its write fails and nothing
 *   creates it again
 * - A row that is not valid is named for repair, edited as its text, and
 *   edited as fields once it reads
 * - A recording's lifecycle writes run in its file's queue, in order
 * - A deletion runs after the file's writes and removes what they saved; its
 *   audio stays
 * - Nothing commits on its own; Save version records a version
 * - Close waits for writes in flight
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { MutationObserver } from '@tanstack/query-core';
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
import type { Library, WriteFailure } from './library.svelte.js';
import { holdCloses } from './opfs-holds.test-support.js';
import {
	createQueryClient,
	focusManager,
	QueryObserver,
	quiet,
} from './query.test-support.js';
import { openTestWorkspace } from './workspace.test-support.js';

const { createLibrary, whisperingKeys } = await import('./library.svelte.ts');

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
 * and `failures` collects every write that failed and was rolled back.
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
	const failures: WriteFailure[] = [];
	library.onWriteFailed((failure) => failures.push(failure));
	const faults = opfsOf(storage).faults;
	return {
		library,
		failures,
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

/** Another program writes the file. */
async function writeElsewhere(library: Library, path: string, content: string) {
	expectOk(await library.folder.files.overwrite(path, content));
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

/** The newest hash the cache confirmed for the recording at `path`. */
const cachedSha = (library: Library, path: string) =>
	library.rowAt('recordings', path)?.sha256;

/** Commits on the branch now. */
async function commits(library: Library) {
	const { data } = await library.folder.git.log(100);
	return data?.length ?? 0;
}

const recordingText = (title: string, audioPath: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: ${audioPath}\n---\n`;

// ============================================================================
// Edits and writes
// ============================================================================

test('an edit changes the cache at once and is written to the file at once', async () => {
	const { library, failures } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;

	editor.edit((row) => {
		row.fields.title = 'Morning notes';
	});
	// The table and the detail read the same cache: both show it now.
	expect(library.entries[0]?.row.fields.title).toBe('Morning notes');
	expect(library.isSaving(editor.path)).toBe(true);
	await quiet(library.queryClient);

	expect(failures).toEqual([]);
	const written = await text(library, editor.path);
	expect(written).toContain('title: Morning notes');
	// The audio link is untouched by typing.
	expect(written).toContain(`audioPath: ${audioPath}`);
	expect(cachedSha(library, editor.path)).toBe(await sha(library, editor.path));
});

test('rapid edits run one write at a time with one waiting, which saves the newest row with no conflict', async () => {
	const { library, failures, counter, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'M';
	});
	await held;
	const before = counter.mdWrites;
	for (const title of ['Mo', 'Mor', 'Morning', 'Morning notes'])
		editor.edit((row) => {
			row.fields.title = title;
		});
	// One write runs and one waits; no more were queued.
	expect(
		library.queryClient.isMutating({
			mutationKey: whisperingKeys.write(editor.path),
		}),
	).toBe(2);
	expect(editor.draft.fields.title).toBe('Morning notes');

	release();
	await quiet(library.queryClient);
	expect(failures).toEqual([]);
	// The held write, then one write of the newest row.
	expect(counter.mdWrites - before).toBe(1);
	expect(await text(library, editor.path)).toContain('title: Morning notes');
	expect(cachedSha(library, editor.path)).toBe(await sha(library, editor.path));

	// The guard moved forward: the next edit writes on top.
	editor.edit((row) => {
		row.fields.title = 'Morning notes, two';
	});
	await quiet(library.queryClient);
	expect(failures).toEqual([]);
	expect(await text(library, editor.path)).toContain(
		'title: Morning notes, two',
	);
});

test('no read starts while a write runs: not on returning to the window, not on Check again, not when a view mounts', async () => {
	const { library, failures, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const client = library.queryClient;
	// The recordings table is on screen: it observes the listing.
	const table = new QueryObserver(client, library.rowsQuery('recordings'));
	const stopTable = table.subscribe(() => {});

	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed while held';
	});
	await held;
	// Returning to the window while the write is held reads nothing.
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	// The client refetches on focus a tick later, after resuming paused writes.
	await Bun.sleep(0);
	expect(client.isFetching()).toBe(0);
	// Neither does the window's own check, nor a view that mounts now.
	await library.check();
	const detail = new QueryObserver(client, library.rowsQuery('recordings'));
	const stopDetail = detail.subscribe(() => {});
	expect(client.isFetching()).toBe(0);
	expect(editor.draft.fields.title).toBe('Typed while held');

	release();
	await settle(library);
	stopDetail();
	stopTable();
	focusManager.setFocused(undefined);
	expect(failures).toEqual([]);
	expect(editor.draft.fields.title).toBe('Typed while held');
	expect(cachedSha(library, editor.path)).toBe(await sha(library, editor.path));

	editor.edit((row) => {
		row.fields.title = 'Typed after';
	});
	await quiet(library.queryClient);
	expect(failures).toEqual([]);
	expect(await text(library, editor.path)).toContain('title: Typed after');
});

test('a write that meets a change made elsewhere rolls back to the file and reports the lost text', async () => {
	const { library, failures } = await open();
	const editor = await record(library);
	const audioPath = editor.draft.fields.audioPath;
	const theirs = recordingText('Theirs', audioPath);
	await writeElsewhere(library, editor.path, theirs);

	editor.edit((row) => {
		row.fields.title = 'Mine';
	});
	await quiet(library.queryClient);
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({
		path: editor.path,
		error: { name: 'Conflict' },
	});
	expect(failures[0]?.lost).toContain('title: Mine');
	// Nothing was written over theirs, and the cache shows the file again.
	expect(await text(library, editor.path)).toBe(theirs);
	expect(editor.draft.fields.title).toBe('Theirs');
	expect(library.holdsUnsavedWork).toBe(false);

	// The next edit writes on top of what is there now.
	editor.edit((row) => {
		row.fields.title = 'Mine';
	});
	await quiet(library.queryClient);
	expect(failures).toHaveLength(1);
	expect(await text(library, editor.path)).toContain('title: Mine');
});

test('a write that fails rolls back, and the write waiting behind it leaves the file as it was', async () => {
	const { library, failures, failNextWrite } = await open();
	const editor = await record(library);
	const saved = await text(library, editor.path);
	failNextWrite(editor.path);
	editor.edit((row) => {
		row.fields.title = 'First';
	});
	editor.edit((row) => {
		row.fields.title = 'Second';
	});
	await quiet(library.queryClient);

	// The rollback lands before the waiting write runs, so it saves the
	// file's own row and fails nothing.
	expect(failures.map((failure) => failure.lost)).toEqual([
		expect.stringContaining('title: Second'),
	]);
	expect(await text(library, editor.path)).toBe(saved);
	expect(editor.draft.fields.title).not.toBe('Second');
});

test('the folder refuses a value it cannot hold, and the cache rolls back', async () => {
	const { library, failures } = await open();
	const editor = await record(library);
	const saved = await text(library, editor.path);
	// Inputs commit only values the schema accepts; this bypasses them.
	editor.edit((row) => {
		(row.fields as { durationMs: unknown }).durationMs = 'long';
	});
	await quiet(library.queryClient);
	expect(failures).toMatchObject([{ error: { name: 'InvalidValues' } }]);
	expect(await text(library, editor.path)).toBe(saved);
	expect(editor.draft.fields.durationMs).toBe(1000);
});

test('a recording deleted elsewhere stays deleted: its write fails, nothing creates it again, and the lost text is reported', async () => {
	const { library, failures } = await open();
	const editor = await record(library);
	const { path } = editor;
	const audioPath = editor.draft.fields.audioPath;
	await deleteElsewhere(library, path);

	editor.edit((row) => {
		row.fields.title = 'Typed after it was deleted';
	});
	await settle(library);

	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({ path, error: { name: 'Conflict' } });
	expect(failures[0]?.lost).toContain('title: Typed after it was deleted');
	expect(await text(library, path)).toBeUndefined();
	// The cache let it go: the table and the detail show it gone.
	expect(library.entries).toEqual([]);
	expect(library.selection).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	// Its audio is an ordinary file, left where it was.
	expect((await library.folder.files.read(audioPath)).error).toBeNull();

	// A later edit has no row to change, and writes nothing.
	library.editRow(
		'recordings',
		path.slice('recordings/'.length, -3),
		(row) => ({
			...row,
			body: 'Still typing.\n',
		}),
	);
	await settle(library);
	expect(await text(library, path)).toBeUndefined();
	expect(failures).toHaveLength(1);
});

test('a transcript deleted elsewhere stays deleted too', async () => {
	const { library, failures } = await open();
	await record(library);
	const editor = await transcript(library);
	await deleteElsewhere(library, editor.path);

	editor.edit((row) => {
		row.body = 'Mine.\n';
	});
	await settle(library);
	expect(failures).toMatchObject([{ path: editor.path }]);
	expect(failures[0]?.lost).toContain('Mine.');
	expect(await text(library, editor.path)).toBeUndefined();
	expect(library.transcriptions).toEqual([]);
});

// ============================================================================
// Repair and Source
// ============================================================================

test('a row that is not valid is named for repair, is written as typed text, and reads as fields once repaired', async () => {
	const { library, failures } = await open();
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
	await settle(library);
	expect(failures).toEqual([]);
	expect(await text(library, path)).toBe(recordingText('Repaired', audioPath));
	expect(library.repairs).toEqual([]);
	expect(await library.useForm(path)).toBeUndefined();
	expect(library.showsText(path)).toBe(false);
	expect(recordingEditor(library).draft.fields.title).toBe('Repaired');
});

test('Source edits a valid row as its exact text, after the fields it was typed in are written', async () => {
	const { library, failures, holdNextMarkdownWrite } = await open();
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
	expect(failures).toEqual([]);
	expect(await text(library, path)).toEndWith('---\nTyped as text.\n');
	expect(await library.useForm(path)).toBeUndefined();
	expect(recordingEditor(library).draft.body).toBe('Typed as text.\n');
});

// ============================================================================
// A recording's lifecycle
// ============================================================================

test('a new recording is in the listing when it opens, even while another write keeps the reread waiting', async () => {
	const { library, failures } = await open();
	// Another file's write, still running: the listing rereads only once it
	// settles, as it does while a person keeps typing elsewhere.
	const other = Promise.withResolvers<void>();
	const running = new MutationObserver(library.queryClient, {
		mutationKey: ['whispering', 'write', 'row', 'elsewhere.md'],
		mutationFn: () => other.promise,
	}).mutate();

	await library.startRecording();
	await library.stopRecording();
	expect(library.recorderError).toBeUndefined();
	const opened = library.selectedPath;
	expect(opened).toBeDefined();
	expect(library.entries.map((entry) => entry.path)).toEqual([opened ?? '']);

	other.resolve();
	await running;
	await settle(library);
	expect(failures).toEqual([]);
	expect(library.entries).toHaveLength(1);
});

test('a recording\u2019s transcript is saved in its file\u2019s queue, after the writes queued before it', async () => {
	const { library, failures, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Titled first';
	});
	await held;
	const [entry] = library.entries;
	if (entry === undefined) throw new Error('Expected a recording');

	const transcribing = library.transcribe(entry);
	await Bun.sleep(20);
	// The answer arrived, and its save waits behind the recording's write.
	expect(library.transcriptionRun(entry.stem)?.kind).toBe('running');
	expect(
		(await library.folder.files.list()).data?.files.map((file) => file.path),
	).not.toContainEqual(expect.stringMatching(/^transcriptions\//));
	expect(library.holdsUnsavedWork).toBe(true);

	release();
	await transcribing;
	await settle(library);
	expect(failures).toEqual([]);
	expect(await text(library, editor.path)).toContain('title: Titled first');
	expect(library.resultsFor(entry.stem)).toHaveLength(1);
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// Deleting
// ============================================================================

test('a deletion runs after the file\u2019s writes and removes the recording and its results, keeping its audio', async () => {
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

test('close waits for a write in flight, and the write lands before the folder closes', async () => {
	const { library, holdNextMarkdownWrite } = await open();
	const editor = await record(library);
	const { held, release } = holdNextMarkdownWrite();
	editor.edit((row) => {
		row.fields.title = 'Typed before closing';
	});
	await held;
	expect(await Promise.race([library.prepareToLeave(), Bun.sleep(20)])).toBe(
		undefined,
	);
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
	const writes = library.queryClient
		.getMutationCache()
		.findAll({ mutationKey: whisperingKeys.write(editor.path) });
	// The write finished before the folder closed; the late edit wrote nothing.
	expect(writes.map((write) => write.state.status)).toEqual(['success']);
});
