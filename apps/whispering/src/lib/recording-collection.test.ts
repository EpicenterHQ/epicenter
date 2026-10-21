/**
 * Recording collection tests
 *
 * Drives the recordings table's logic, and the transcript editor the details
 * use, against a real directory holding a made-up history: several
 * recordings with titles, notes, lengths, and transcripts old and new, one
 * with no audio, and one whose file does not read. The endpoints are stubs
 * that record every request. No component is mounted, so these establish
 * what the table shows and does, not how it looks.
 *
 * Key behaviors:
 * - A search finds a recording by text remembered from any of its
 *   transcripts, its notes, its title, or its ID, and shows the passage it
 *   found; files that need repair are listed apart
 * - Sorting is the same order every time: equal rows keep one order in both
 *   directions and rows with no value come last
 * - The selection is by path: it survives a search, a sort, and a refresh,
 *   counts what a search hides, and drops a recording that left the folder
 * - Copying takes the newest transcript of each selected row in table order
 * - Transcribing several sends the audio each row names, once each, one at a
 *   time, and reports what was sent, skipped, and failed without retrying
 * - A recording whose audio the folder does not hold says so on its row, and
 *   it is skipped rather than sent
 * - Deleting several captures each deletion first, leaves out what the
 *   library refuses, removes only what was captured, and keeps the audio
 * - A transcript is edited in its own draft beside its recording, which stays
 *   selected, and saves as it is typed; an outside change merges with the
 *   next save; closing the details or changing page discards nothing
 * - A recording that left the folder is unticked when a listing confirms it,
 *   so a file made later at its path is not ticked; a search and a failed
 *   listing untick nothing
 * - Once the app is closing, nothing new is opened, and a recording still
 *   waiting its turn to be transcribed is not sent
 */
import {
	closeTestWhispering,
	openTestWhispering,
} from './library.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
import type { RecordingFields, TranscriptionFields } from './definition.js';
import { settle, transcriptEditor } from './edits.test-support.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import {
	captureDeletions,
	DEFAULT_SORT,
	deleteCaptured,
	describeDeletions,
	nextSort,
	selectionIn,
	shownRows,
	toggleAllShown,
	toggleSelected,
	transcribeRows,
	transcriptExcerpt,
	transcriptsToCopy,
} from './recording-collection.js';
import {
	deferred,
	eventually,
	openTestServices,
	replaceTables,
} from './services.test-support.js';
import type { Whispering } from './whispering.svelte.js';

/** The recording rows and their sibling audio, sorted. */
const recordingFiles = async (root: string) =>
	(await readdir(join(root, 'recordings')).catch(() => [] as string[])).sort();

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Transcribe = WhisperingServices['transcribe'];

/**
 * A folder with a history, written as another program would have left it:
 *
 * | ID      | Title            | Recorded   | Length | Transcripts                    |
 * | ------- | ---------------- | ---------- | ------ | ------------------------------ |
 * | standup | Monday standup   | 2026-03-02 | 5:00   | one                            |
 * | dentist | Dentist reminder | 2026-03-05 | 0:30   | none; notes mention the garage |
 * | walk    | Walk ideas       | 2026-03-04 | 5:00   | an older and a newer one       |
 * | lecture | Lecture notes    | 2026-03-01 | 50:00  | none                           |
 * | orphan  | Lost audio       | 2026-03-03 | 1:00   | none, and no capture source    |
 * | broken  | (does not read)  |            |        |                                |
 */
async function history(
	transcribe?: Transcribe,
	/** Put something in the way of the folder the app is given, after the history is written. */
	folderOf: (folder: WhisperingFolder) => WhisperingFolder = (given) => given,
) {
	const test = await openTestServices();
	const { folder } = test;
	const sent: Parameters<Transcribe>[0][] = [];
	const recording = async (
		stem: string,
		title: string,
		day: string,
		durationMs: number,
		body = '',
	) => {
		const audioPath = `recordings/${stem}.wav`;
		expectOk(await folder.files.write(audioPath, null, toneWav()));
		expectOk(
			await folder.tables.recordings.set(stem, null, {
				fields: {
					title,
					recordedAt: `2026-03-${day}T09:00:00.000Z`,
					durationMs,
					capture: 'microphone',
				} as RecordingFields,
				body,
			}),
		);
	};
	const transcript = async (
		stem: string,
		recordingId: string,
		day: string,
		body: string,
	) =>
		expectOk(
			await folder.tables.transcriptions.set(stem, null, {
				fields: {
					recordingId,
					createdAt: `2026-03-${day}T10:00:00.000Z`,
					model: 'verification-model',
					endpoint: 'http://127.0.0.1:18080/v1',
				} as TranscriptionFields,
				body,
			}),
		);

	await recording('standup', 'Monday standup', '02', 300_000);
	await recording(
		'dentist',
		'Dentist reminder',
		'05',
		30_000,
		'Ask about the garage parking pass.\n',
	);
	await recording('walk', 'Walk ideas', '04', 300_000);
	await recording('lecture', 'Lecture notes', '01', 3_000_000);
	expectOk(
		await folder.files.write(
			'recordings/orphan.md',
			null,
			'---\ntitle: Lost audio\nrecordedAt: 2026-03-03T09:00:00.000Z\ndurationMs: 60000\n---\n',
		),
	);
	expectOk(
		await folder.files.write(
			'recordings/broken.md',
			null,
			'no frontmatter here\n',
		),
	);
	await transcript(
		'standup-t1',
		'standup',
		'02',
		'Yesterday I finished the importer. Today I start on the exporter.\n',
	);
	await transcript(
		'walk-t1',
		'walk',
		'04',
		'A long first take about nothing much, then at the very end one thing worth keeping: plant the persimmon tree by the north fence before the frost.\n',
	);
	await transcript(
		'walk-t2',
		'walk',
		'06',
		'Second take, cleaner. Ideas for the garden layout and the path.\n',
	);

	const whispering = await openTestWhispering({
		folder: folderOf(test.folder),
		services: {
			...test.services,
			async transcribe(request) {
				sent.push(request);
				return transcribe
					? transcribe(request)
					: Ok({ text: `words from ${request.audioPath}` });
			},
		},
	});
	cleanups.push(async () => {
		await closeTestWhispering(whispering);
		await test.remove();
	});
	return {
		whispering,
		library: whispering.library,
		view: whispering.view,
		sent,
		root: test.root,
	};
}

const path = (stem: string) => `recordings/${stem}.md`;
const stems = (rows: readonly { entry: { stem: string } }[]) =>
	rows.map((row) => row.entry.stem);
/** One recording's row as the table has it now. */
function rowOf(library: Whispering['library'], stem: string) {
	const row = shownRows(library, '', DEFAULT_SORT).find(
		(item) => item.entry.stem === stem,
	);
	if (row === undefined) throw new Error(`${stem} is listed`);
	return row;
}

// ============================================================================
// Search
// ============================================================================

test('text remembered from an older transcript finds its recording and shows the passage', async () => {
	const { library } = await history();

	const found = shownRows(library, '  Persimmon Tree ', DEFAULT_SORT);

	expect(stems(found)).toEqual(['walk']);
	const walk = found[0]!;
	// The newest transcript does not have the words; the row shows where they are.
	expect(walk.transcripts[0]!.row.body).not.toContain('persimmon');
	const excerpt = transcriptExcerpt(walk, 'Persimmon Tree');
	expect(excerpt).toContain('plant the persimmon tree by the north fence');
	expect(excerpt?.startsWith('…')).toBe(true);
	// With no search, a row shows the start of its newest transcript.
	expect(transcriptExcerpt(walk, '')).toBe(
		'Second take, cleaner. Ideas for the garden layout and the path.',
	);
});

test('a search also reads notes, titles, and IDs, and says nothing for a recording with no transcript', async () => {
	const { library } = await history();
	const search = (query: string) =>
		stems(shownRows(library, query, DEFAULT_SORT));

	expect(search('garage')).toEqual(['dentist']);
	expect(search('STANDUP')).toEqual(['standup']);
	expect(search('lectur')).toEqual(['lecture']);
	expect(search('nothing has this')).toEqual([]);
	// Found by its notes, it has no transcript to show a line of.
	const dentist = rowOf(library, 'dentist');
	expect(transcriptExcerpt(dentist, 'garage')).toBeUndefined();
	expect(dentist.status).toBe('untranscribed');
	// A file with no audio named, and one that does not read, need repair: they are listed apart.
	expect(library.repairs.map((item) => item.stem)).toEqual([
		'broken',
		'orphan',
	]);
	expect(library.repairs[1]!.reason).toContain('capture');
});

// ============================================================================
// Sorting
// ============================================================================

test('sorting gives one order every time: ties keep their order both ways', async () => {
	const { library } = await history();
	const order = (
		key: 'recordedAt' | 'durationMs' | 'title' | 'status',
		direction: 'asc' | 'desc',
	) => stems(shownRows(library, '', { key, direction }));

	expect(order('recordedAt', 'desc')).toEqual([
		'dentist',
		'walk',
		'standup',
		'lecture',
	]);
	// standup and walk are the same length: standup's path sorts first, either way.
	expect(order('durationMs', 'asc')).toEqual([
		'dentist',
		'standup',
		'walk',
		'lecture',
	]);
	expect(order('durationMs', 'desc')).toEqual([
		'lecture',
		'standup',
		'walk',
		'dentist',
	]);
	expect(order('title', 'asc').slice(0, 3)).toEqual([
		'dentist',
		'lecture',
		'standup',
	]);
	// What needs attention sorts ahead of what is done.
	expect(order('status', 'asc')).toEqual([
		'dentist',
		'lecture',
		'standup',
		'walk',
	]);

	expect(nextSort(DEFAULT_SORT, 'recordedAt')).toEqual({
		key: 'recordedAt',
		direction: 'asc',
	});
	expect(nextSort(DEFAULT_SORT, 'title')).toEqual({
		key: 'title',
		direction: 'asc',
	});
	expect(nextSort(DEFAULT_SORT, 'durationMs')).toEqual({
		key: 'durationMs',
		direction: 'desc',
	});
});

// ============================================================================
// Selection
// ============================================================================

test('a selection is by path: it holds through a search, a sort, and a refresh, and drops what left the folder', async () => {
	const { library, view } = await history();
	expect(view.recordingSelected).toEqual([]);
	expect(view.recordingSort).toEqual(DEFAULT_SORT);

	for (const stem of ['walk', 'dentist', 'lecture'])
		view.recordingSelected = toggleSelected(
			view.recordingSelected,
			path(stem),
			true,
			library,
		);
	const all = shownRows(library, '', DEFAULT_SORT);
	// In table order, whatever order they were ticked in.
	expect(stems(selectionIn(view.recordingSelected, all, library).rows)).toEqual(
		['dentist', 'walk', 'lecture'],
	);

	// A search that hides two of them says so, and acts only on what it shows.
	view.recordingQuery = 'garden';
	const searched = shownRows(library, view.recordingQuery, view.recordingSort);
	expect(stems(searched)).toEqual(['walk']);
	expect(selectionIn(view.recordingSelected, searched, library)).toMatchObject({
		hidden: 2,
	});
	expect(
		stems(selectionIn(view.recordingSelected, searched, library).rows),
	).toEqual(['walk']);

	// Clearing what is shown leaves what is hidden; selecting what is shown adds to it.
	view.recordingSelected = toggleAllShown(
		view.recordingSelected,
		searched,
		false,
		library,
	);
	expect(view.recordingSelected.sort()).toEqual([
		path('dentist'),
		path('lecture'),
	]);
	view.recordingSelected = toggleAllShown(
		view.recordingSelected,
		searched,
		true,
		library,
	);
	expect(view.recordingSelected.sort()).toEqual(
		['dentist', 'lecture', 'walk'].map(path),
	);

	// A new order and a refresh change nothing about what is selected.
	view.recordingQuery = '';
	view.recordingSort = nextSort(view.recordingSort, 'title');
	await settle(library);
	const sorted = shownRows(library, view.recordingQuery, view.recordingSort);
	expect(
		stems(selectionIn(view.recordingSelected, sorted, library).rows),
	).toEqual(['dentist', 'lecture', 'walk']);

	// A selected recording deleted from the folder is no longer selected, or counted as hidden.
	const deletion = expectOk(await library.deletionFor(path('lecture')));
	expect(await library.delete(deletion)).toBeUndefined();
	const after = shownRows(library, 'standup', view.recordingSort);
	expect(selectionIn(view.recordingSelected, after, library)).toMatchObject({
		hidden: 2,
	});
	expect(
		stems(selectionIn(view.recordingSelected, after, library).rows),
	).toEqual([]);
	view.recordingSelected = toggleSelected(
		view.recordingSelected,
		path('standup'),
		true,
		library,
	);
	expect(view.recordingSelected).not.toContain(path('lecture'));
	// A path that is not in the folder cannot be selected.
	expect(toggleSelected([], path('lecture'), true, library)).toEqual([]);
});

// ============================================================================
// Copying
// ============================================================================

test('copying takes the newest transcript of each selected row, in table order, and counts the rows with none', async () => {
	const { library } = await history();
	const rows = shownRows(library, '', { key: 'title', direction: 'asc' });
	const selected = selectionIn(
		[path('walk'), path('dentist'), path('standup')],
		rows,
		library,
	).rows;

	expect(transcriptsToCopy(selected)).toEqual({
		text: 'Monday standup\nYesterday I finished the importer. Today I start on the exporter.\n\nWalk ideas\nSecond take, cleaner. Ideas for the garden layout and the path.',
		copied: 2,
		without: 1,
	});
	// One transcript copies as its text alone.
	expect(
		transcriptsToCopy(selected.filter((row) => row.entry.stem === 'walk')).text,
	).toBe('Second take, cleaner. Ideas for the garden layout and the path.');
	expect(transcriptsToCopy([])).toEqual({ text: '', copied: 0, without: 0 });
});

// ============================================================================
// Transcribing several
// ============================================================================

test('transcribing several sends the audio each row names once, in order, and skips what has a transcript or no audio', async () => {
	const { library, sent, root } = await history();
	const rows = shownRows(library, '', DEFAULT_SORT);
	// Everything is selected; nothing has been sent by selecting.
	expect(sent).toEqual([]);
	const progress: number[] = [];

	const outcome = await transcribeRows(
		library,
		rows.map((row) => row.path),
		(done) => progress.push(done),
	);

	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
		'recordings/lecture.wav',
	]);
	expect(outcome.transcribed).toEqual(['Dentist reminder', 'Lecture notes']);
	expect(outcome.failed).toEqual([]);
	expect(outcome.skipped).toEqual([
		{ title: 'Walk ideas', reason: 'It already has a transcript.' },
		{ title: 'Monday standup', reason: 'It already has a transcript.' },
	]);
	expect(progress).toEqual([1, 2, 3, 4]);
	expect(library.resultsFor('dentist')[0]!.row.body).toBe(
		'words from recordings/dentist.wav\n',
	);
	expect((await readdir(join(root, 'transcriptions'))).length).toBe(5);

	// Asked again, everything now has a transcript: nothing more is sent.
	await transcribeRows(
		library,
		rows.map((row) => row.path),
	);
	expect(sent).toHaveLength(2);
});

test('a recording whose audio is not in the folder says so on its row and is not sent', async () => {
	const { library, sent, root } = await history();
	await rm(join(root, 'recordings', 'lecture.wav'));
	await settle(library);
	expect(rowOf(library, 'lecture').audio).toEqual({
		kind: 'absent',
		path: 'recordings/lecture.*',
	});
	expect(rowOf(library, 'dentist').audio).toEqual({
		kind: 'here',
		path: 'recordings/dentist.wav',
	});

	const outcome = await transcribeRows(library, [
		path('dentist'),
		path('lecture'),
	]);
	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
	]);
	expect(outcome.skipped).toEqual([
		{
			title: 'Lecture notes',
			reason: 'Its audio isn’t on this device.',
		},
	]);
});

test('a transcription that fails is reported, is not sent again, and does not stop the ones after it', async () => {
	const { library, sent } = await history(async ({ audioPath }) => {
		if (audioPath === 'recordings/dentist.wav')
			throw new Error('the endpoint hung up');
		return Ok({ text: 'arrived' });
	});

	const outcome = await transcribeRows(library, [
		path('dentist'),
		path('lecture'),
		path('gone'),
	]);

	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
		'recordings/lecture.wav',
	]);
	expect(outcome.transcribed).toEqual(['Lecture notes']);
	expect(outcome.failed).toHaveLength(1);
	expect(outcome.failed[0]).toMatchObject({ title: 'Dentist reminder' });
	expect(outcome.failed[0]!.reason).toContain('the endpoint hung up');
	expect(outcome.skipped).toEqual([
		{ title: path('gone'), reason: 'It is no longer in the folder.' },
	]);
	// The failure is on the transcript's row, which stays without a body, there
	// to be run again by the person.
	expect(rowOf(library, 'dentist').status).toBe('failed');
	expect(library.resultsFor('dentist').map((item) => item.row.body)).toEqual([
		'',
	]);
});

test('several are transcribed one at a time: the next is not sent until the one before it has answered', async () => {
	const first = deferred<Awaited<ReturnType<Transcribe>>>();
	const { library, sent } = await history(({ audioPath }) =>
		audioPath === 'recordings/dentist.wav'
			? first.promise
			: Promise.resolve(Ok({ text: 'arrived' })),
	);

	const running = transcribeRows(library, [path('dentist'), path('lecture')]);
	await eventually(() => sent.length > 0);
	for (let turn = 0; turn < 50; turn++) await Promise.resolve();
	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
	]);
	expect(rowOf(library, 'dentist').status).toBe('transcribing');

	first.resolve(Ok({ text: 'arrived late' }));
	expect((await running).transcribed).toEqual([
		'Dentist reminder',
		'Lecture notes',
	]);
	expect(sent).toHaveLength(2);
});

// ============================================================================
// Deleting several
// ============================================================================

test('deleting several captures each deletion first, removes exactly those with their results, and keeps the audio', async () => {
	const { library, root } = await history();

	const captured = await captureDeletions(library, [
		path('walk'),
		path('standup'),
	]);

	expect(captured.refused).toEqual([]);
	expect(captured.deletions.map((item) => item.id)).toEqual([
		'walk',
		'standup',
	]);
	// Capturing deletes nothing.
	expect(library.entries).toHaveLength(4);
	const told = describeDeletions(captured);
	expect(told.title).toBe('Delete 2 recordings?');
	expect(told.description).toContain('2 recording files, 3 results');
	expect(told.description).toContain('“Walk ideas”, “Monday standup”');
	expect(told.description).toContain('The 2 audio files are not deleted');

	expect(await deleteCaptured(library, captured.deletions)).toEqual({
		deleted: 2,
		problems: [],
	});

	expect(await recordingFiles(root)).toEqual([
		'broken.md',
		'dentist.md',
		'dentist.wav',
		'lecture.md',
		'lecture.wav',
		'orphan.md',
		'standup.wav',
		'walk.wav',
	]);
	expect(await readdir(join(root, 'transcriptions'))).toEqual([]);
});

test('a recording with a transcription under way is left out with the library’s reason, and the rest are still captured', async () => {
	const answer = deferred<Awaited<ReturnType<Transcribe>>>();
	const { library } = await history(() => answer.promise);
	const running = library.transcribe(
		library.entries.find((entry) => entry.stem === 'dentist')!,
	);

	const captured = await captureDeletions(library, [
		path('dentist'),
		path('lecture'),
	]);

	expect(captured.deletions.map((item) => item.id)).toEqual(['lecture']);
	expect(captured.refused).toHaveLength(1);
	expect(captured.refused[0]!.reason).toContain('still running');
	expect(describeDeletions(captured).description).toContain(
		'1 selected recording is left out and kept: “Dentist reminder”',
	);
	answer.resolve(Ok({ text: 'arrived' }));
	await running;
});

test('while a result cannot be told apart from a recording’s own, none is captured, and a recording changed after capture is not removed', async () => {
	const { library, root } = await history();
	const captured = await captureDeletions(library, [
		path('standup'),
		path('walk'),
	]);
	// Something else writes a result that cannot say whose it is.
	await writeFile(join(root, 'transcriptions', 'stray.md'), 'not a row\n');
	await settle(library);

	expect(
		(await captureDeletions(library, [path('standup')])).deletions,
	).toEqual([]);
	const { deleted, problems } = await deleteCaptured(
		library,
		captured.deletions,
	);

	expect(deleted).toBe(0);
	expect(problems.map((problem) => problem.title)).toEqual([
		'Monday standup',
		'Walk ideas',
	]);
	expect(problems[0]!.reason).toContain('cannot be told apart');
	expect(library.entries).toHaveLength(4);
});

// ============================================================================
// Editing a transcript beside its recording
// ============================================================================

const TRANSCRIPT = 'transcriptions/standup-t1.md';

test('a transcript is edited beside its recording, which stays selected, and is written at once', async () => {
	const { library, root } = await history();
	await library.open(path('standup'));
	const before = await readFile(join(root, TRANSCRIPT), 'utf8');

	const editor = transcriptEditor(library, TRANSCRIPT);
	editor.edit((row) => {
		row.body = 'Yesterday I finished the importer. Today: the exporter.\n';
	});
	// Written from the moment it is typed.
	expect(library.isSaving(TRANSCRIPT)).toBe(true);
	expect(library.saving).toBe(true);
	await settle(library);
	// The list shows the saved text: the save put it in the listing.
	expect(transcriptExcerpt(rowOf(library, 'standup'), '')).toBe(
		'Yesterday I finished the importer. Today: the exporter.',
	);

	const saved = await readFile(join(root, TRANSCRIPT), 'utf8');
	// The fields as they were, the new text.
	expect(saved.split('---')[1]).toBe(before.split('---')[1]);
	expect(saved).toContain('Today: the exporter.');
	expect(library.saving).toBe(false);
	expect(library.selectedPath).toBe(path('standup'));
	expect(library.selection?.kind).toBe('recording');

	// Opening the file from Files edits the same row.
	expect(await library.open(TRANSCRIPT)).toBeUndefined();
	expect(library.selection).toMatchObject({ kind: 'file', path: TRANSCRIPT });
	expect(library.edit('transcriptions', TRANSCRIPT).markdown?.body).toBe(
		'Yesterday I finished the importer. Today: the exporter.\n',
	);
});

test('typing over a transcript changed outside, before the window read it again, merges with the change', async () => {
	const { library, root } = await history();
	await library.open(path('standup'));
	const notices: WriteFailure[] = [];
	library.onWriteFailure((notice) => notices.push(notice));
	const editor = transcriptEditor(library, TRANSCRIPT);
	const outside = (await readFile(join(root, TRANSCRIPT), 'utf8')).replace(
		'importer',
		'migration',
	);
	await writeFile(join(root, TRANSCRIPT), outside);

	// Typing before the window read it again: both replaced the same line,
	// so the typing wins there, and nothing is told.
	editor.edit((row) => {
		row.body = 'What I typed.\n';
	});
	await settle(library);
	expect(notices).toEqual([]);
	const saved = await readFile(join(root, TRANSCRIPT), 'utf8');
	expect(saved).toContain('What I typed.');
	expect(saved).not.toContain('migration');
	expect(library.selectedPath).toBe(path('standup'));
});

test('closing the details and changing page lose no typing: the draft belongs to the app and saves as typed', async () => {
	const { whispering, library, view, root } = await history();
	await library.open(path('standup'));
	view.showingDetail = true;
	const draft = transcriptEditor(library, TRANSCRIPT);
	draft.edit((row) => {
		row.body = 'Typed just before closing the details.\n';
	});
	view.recordingQuery = 'standup';

	// Closing the pane, then a change of page: neither unloads the document.
	view.showingDetail = false;
	expect(whispering.blocksNavigation({ willUnload: false })).toBe(false);
	expect(library.selectedPath).toBe(path('standup'));
	// Leaving the app is what is held back while the save runs.
	expect(whispering.blocksNavigation({ willUnload: true })).toBe(true);

	await settle(library);
	expect(await readFile(join(root, TRANSCRIPT), 'utf8')).toContain(
		'Typed just before closing the details.',
	);
});

// ============================================================================
// Selection against a folder that changes
// ============================================================================

test('a selected recording that left the folder is unticked once a listing confirms it, so a new file at its path is not ticked', async () => {
	const listing = { fails: false };
	const { library, view, root } = await history(undefined, (folder) => {
		const { recordings } = folder.tables;
		return replaceTables(folder, {
			recordings: {
				...recordings,
				list: async () =>
					listing.fails
						? ({
								data: null,
								error: { name: 'Io', message: 'the disk did not answer' },
							} as never)
						: recordings.list(),
			},
		});
	});
	const row = await readFile(join(root, path('standup')), 'utf8');
	for (const stem of ['standup', 'walk'])
		view.recordingSelected = toggleSelected(
			view.recordingSelected,
			path(stem),
			true,
			library,
		);

	// A search that hides a selected row unticks nothing, however often the folder is read.
	view.recordingQuery = 'garden';
	await settle(library);
	expect(view.recordingSelected).toEqual([path('standup'), path('walk')]);

	// The file goes, but the listing that would say so fails: nothing is taken as gone.
	await rm(join(root, path('standup')));
	listing.fails = true;
	await settle(library);
	expect(library.listError).toContain('the disk did not answer');
	expect(view.recordingSelected).toEqual([path('standup'), path('walk')]);

	// A listing that is read confirms it gone, and it is unticked then.
	listing.fails = false;
	await settle(library);
	expect(view.recordingSelected).toEqual([path('walk')]);

	// Another file made at that path later is another recording: it arrives unticked.
	await writeFile(
		join(root, path('standup')),
		row.replace('Monday standup', 'A different recording'),
	);
	view.recordingQuery = '';
	await settle(library);
	expect(rowOf(library, 'standup').title).toBe('A different recording');
	const shown = shownRows(library, '', DEFAULT_SORT);
	expect(
		stems(selectionIn(view.recordingSelected, shown, library).rows),
	).toEqual(['walk']);
	expect(selectionIn(view.recordingSelected, shown, library).hidden).toBe(0);
});

// ============================================================================
// Closing
// ============================================================================

test('nothing is opened or read after closing', async () => {
	const reads: string[] = [];
	const { whispering, library } = await history(undefined, (folder) => {
		const { files } = folder;
		return replaceTables(
			folder,
			{},
			{
				...files,
				async read(target: string) {
					reads.push(target);
					return files.read(target);
				},
			},
		);
	});
	await library.open(path('standup'));
	await closeTestWhispering(whispering);
	expect(library.closing).toBe(true);
	const before = reads.length;
	await library.open('transcriptions/walk-t2.md');
	await library.open(path('walk'));
	expect(library.selectedPath).toBe(path('standup'));
	expect(reads).toHaveLength(before);
});

test('typing in a transcript that was opened before closing is saved before the folder closes', async () => {
	const { whispering, library, root } = await history();
	transcriptEditor(library, TRANSCRIPT).edit((row) => {
		row.body = 'Typed just before quitting.\n';
	});

	await closeTestWhispering(whispering);

	expect(await readFile(join(root, TRANSCRIPT), 'utf8')).toContain(
		'Typed just before quitting.',
	);
});

test('closing while several are being transcribed sends nothing more: the one under way ends as it ends, the rest are reported as not sent', async () => {
	const first = deferred<Awaited<ReturnType<Transcribe>>>();
	const { whispering, library, sent, root } = await history(
		() => first.promise,
	);

	const running = transcribeRows(library, [
		path('dentist'),
		path('lecture'),
		path('standup'),
	]);
	await eventually(() => sent.length > 0);
	for (let turn = 0; turn < 50; turn++) await Promise.resolve();
	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
	]);

	await closeTestWhispering(whispering);
	first.resolve(Ok({ text: 'arrived after the close' }));
	const outcome = await running;

	// One request, ever: the queued row was not sent, and nothing was sent twice.
	expect(sent.map((request) => request.audioPath)).toEqual([
		'recordings/dentist.wav',
	]);
	expect(outcome.skipped).toEqual([
		{
			title: 'Lecture notes',
			reason: 'The app was closing, so it was not sent.',
		},
		{
			title: 'Monday standup',
			reason: 'The app was closing, so it was not sent.',
		},
	]);
	// The one that was sent is not called transcribed: its answer arrived
	// after the folder closed, so its file could not be written. Its row stays
	// without a body, unfinished on the next open. The app released what
	// it listed when it closed, so the row is read from disk.
	expect(outcome.transcribed).toEqual([]);
	expect(outcome.failed.map((item) => item.title)).toEqual([
		'Dentist reminder',
	]);
	const written = (await readdir(join(root, 'transcriptions'))).filter(
		(name) => !['standup-t1.md', 'walk-t1.md', 'walk-t2.md'].includes(name),
	);
	expect(written).toHaveLength(1);
	expect(
		await readFile(join(root, 'transcriptions', written[0]!), 'utf8'),
	).toEndWith('---\n');
	// Asked again after closing, the library sends nothing.
	await library.transcribe({
		stem: 'lecture',
	});
	expect(sent).toHaveLength(1);
	expect(library.transcriptionRun('lecture')).toBeUndefined();
});
