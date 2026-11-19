/**
 * The recordings table's pages and the selection across them.
 *
 * Key behaviors:
 * - The search and sort run over every recording; a page is a slice of what
 *   they keep, brought into range when rows go.
 * - A new search or order starts at the first page; the same one set again
 *   keeps the page.
 * - Ticking a page leaves the other pages' ticks alone; selecting every row
 *   the search keeps reaches past the page.
 * - A shift-click ticks a range on one page.
 * - A delete confirmation names a few recordings and counts the rest.
 */
import { expect, test } from 'bun:test';
import type { RecordingNote } from './folder.js';
import {
	DEFAULT_SORT,
	describeDeletions,
	PAGE_SIZE,
	pageOf,
	selectionIn,
	selectionReach,
	selectRange,
	shownRows,
	toggleRows,
	toggleSelected,
	viewWith,
} from './recordings-table.js';

/** `count` recordings, `r0000` the oldest, each recorded a minute after the last. */
function libraryOf(count: number) {
	const entries: RecordingNote[] = Array.from({ length: count }, (_, i) => ({
		id: `r${String(i).padStart(4, '0')}`,
		title: i % 2 === 0 ? `Even ${i}` : `Odd ${i}`,
		recordedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
		body: '',
	}));
	return {
		entries,
		transcriptsFor: () => [],
		transcribing: () => false,
		audioOf: () => ({ kind: 'absent' }) as const,
	};
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

test('a page is one slice of the rows, counted from 1 over every page', () => {
	const rows = shownRows(libraryOf(250), '', DEFAULT_SORT);

	const second = pageOf(rows, 1);

	expect(second.rows).toHaveLength(PAGE_SIZE);
	expect(second).toMatchObject({
		index: 1,
		count: 3,
		from: 101,
		to: 200,
		total: 250,
	});
	// Newest first: the second page starts at the 101st newest.
	expect(second.rows[0]?.id).toBe('r0149');
	expect(pageOf(rows, 2)).toMatchObject({ from: 201, to: 250 });
});

test('a page past the last shows the last, so deleting its rows leaves the page before', () => {
	const library = libraryOf(250);
	const before = pageOf(shownRows(library, '', DEFAULT_SORT), 2);
	expect(before.index).toBe(2);

	library.entries.splice(0, 50);
	const after = pageOf(shownRows(library, '', DEFAULT_SORT), before.index);

	expect(after).toMatchObject({ index: 1, count: 2, from: 101, to: 200 });
});

test('an empty table is one empty page, and a page before the first is the first', () => {
	expect(pageOf([], 3)).toMatchObject({
		rows: [],
		index: 0,
		count: 1,
		from: 0,
		to: 0,
		total: 0,
	});
	expect(pageOf(shownRows(libraryOf(5), '', DEFAULT_SORT), -1).index).toBe(0);
});

test('a new search or a new order starts at the first page', () => {
	const view = {
		recordingQuery: '',
		recordingSort: DEFAULT_SORT,
		recordingPage: 4,
	};

	expect(viewWith(view, { recordingQuery: 'odd' }).recordingPage).toBe(0);
	expect(
		viewWith(view, { recordingSort: { key: 'title', direction: 'asc' } })
			.recordingPage,
	).toBe(0);
	expect(
		viewWith(view, { recordingSort: { key: 'recordedAt', direction: 'asc' } })
			.recordingPage,
	).toBe(0);
});

test('the same search or order set again keeps the page', () => {
	const view = {
		recordingQuery: 'odd',
		recordingSort: DEFAULT_SORT,
		recordingPage: 4,
	};

	expect(viewWith(view, { recordingQuery: 'Odd ' }).recordingPage).toBe(4);
	expect(
		viewWith(view, { recordingSort: { ...DEFAULT_SORT } }).recordingPage,
	).toBe(4);
	expect(viewWith(view, { recordingPage: 5 })).toEqual({
		...view,
		recordingPage: 5,
	});
});

test('ticking a page selects its rows and leaves the other pages ticked', () => {
	const library = libraryOf(250);
	const rows = shownRows(library, '', DEFAULT_SORT);
	const first = pageOf(rows, 0);
	const second = pageOf(rows, 1);
	const elsewhere = ids(second.rows).slice(0, 3);

	const ticked = toggleRows(elsewhere, first.rows, true, library);
	expect(new Set(ticked)).toEqual(new Set([...elsewhere, ...ids(first.rows)]));

	const cleared = toggleRows(ticked, first.rows, false, library);
	expect(cleared).toEqual(elsewhere);
});

test('a whole page offers every match; selecting them all reaches past the page', () => {
	const library = libraryOf(250);
	const rows = shownRows(library, 'odd', DEFAULT_SORT);
	const page = pageOf(rows, 0);
	expect(rows).toHaveLength(125);

	const pageTicked = toggleRows([], page.rows, true, library);
	const shown = selectionIn(pageTicked, rows, library);
	expect(shown.rows).toHaveLength(PAGE_SIZE);
	expect(selectionReach(new Set(ids(shown.rows)), page, rows)).toBe('page');

	const allTicked = toggleRows(pageTicked, rows, true, library);
	const all = selectionIn(allTicked, rows, library);
	// Every match is acted on, and nothing the search hides.
	expect(all.rows).toHaveLength(125);
	expect(all.hidden).toBe(0);
	expect(selectionReach(new Set(ids(all.rows)), page, rows)).toBe('all');
});

test('a part of a page, or a table of one page, reaches nothing further', () => {
	const library = libraryOf(250);
	const rows = shownRows(library, '', DEFAULT_SORT);
	const page = pageOf(rows, 0);
	const some = new Set(ids(page.rows).slice(1));
	expect(selectionReach(some, page, rows)).toBeUndefined();

	const small = shownRows(libraryOf(20), '', DEFAULT_SORT);
	expect(
		selectionReach(new Set(ids(small)), pageOf(small, 0), small),
	).toBeUndefined();
});

test('a shift-click ticks every row between the last click and this one', () => {
	const library = libraryOf(250);
	const page = pageOf(shownRows(library, '', DEFAULT_SORT), 0).rows;
	const [a = '', b = '', c = '', d = ''] = ids(page.slice(10, 14));

	const ticked = selectRange([a], page, a, d, true, library);
	expect(new Set(ticked)).toEqual(new Set([a, b, c, d]));

	// Upward, and clearing, as the clicked row now is.
	const cleared = selectRange(ticked, page, d, b, false, library);
	expect(cleared).toEqual([a]);
});

test('a shift-click with no earlier click on the page changes that row alone', () => {
	const library = libraryOf(250);
	const rows = shownRows(library, '', DEFAULT_SORT);
	const first = pageOf(rows, 0).rows;
	const second = pageOf(rows, 1).rows;
	const anchor = second[0]?.id;
	const id = first[5]?.id ?? '';

	expect(selectRange([], first, anchor, id, true, library)).toEqual([id]);
	expect(selectRange([], first, undefined, id, true, library)).toEqual(
		toggleSelected([], id, true, library),
	);
});

/** A recording deletion as `captureDeletions` captures it. */
const deletionOf = (i: number, audio?: string, transcripts = 0) => ({
	kind: 'recording' as const,
	id: `r${i}`,
	title: `Note ${i}`,
	noted: true,
	audio,
	transcripts: Array.from({ length: transcripts }, (_, t) => ({
		collection: 'transcriptions' as const,
		id: `t${i}-${t}`,
	})),
});

const refusal = (transcribing: boolean) => ({
	title: 'Busy',
	reason: 'reason',
	transcribing,
});

test('more than three recordings are counted in the title, not named', () => {
	const deletions = Array.from({ length: 15_000 }, (_, i) =>
		deletionOf(i, `recordings/r${i}.wav`, 1),
	);
	const { title, description } = describeDeletions({ deletions, refused: [] });
	expect(title).toBe(`Delete ${(15_000).toLocaleString()} recordings?`);
	expect(description).toContain(
		`Their audio and ${(15_000).toLocaleString()} transcripts`,
	);
	expect(description).not.toContain('Note');
});

test('three or fewer recordings are named in the title', () => {
	const { title } = describeDeletions({
		deletions: [deletionOf(0), deletionOf(1), deletionOf(2)],
		refused: [],
	});
	expect(title).toBe('Delete “Note 0”, “Note 1” and “Note 2”?');
});

test('without audio or transcripts, it only says it cannot be undone', () => {
	const { description } = describeDeletions({
		deletions: [deletionOf(0)],
		refused: [],
	});
	expect(description).toBe('This can’t be undone.');
});

test('recordings being transcribed are said to be kept for that reason', () => {
	const { description } = describeDeletions({
		deletions: [deletionOf(0, 'recordings/r0.wav')],
		refused: [refusal(true), refusal(true)],
	});
	expect(description).toContain('This can’t be undone.');
	expect(description).toContain(
		'2 selected recordings are being transcribed and are kept.',
	);
});

test('recordings kept for mixed reasons are said to be kept, without a reason', () => {
	const { description } = describeDeletions({
		deletions: [deletionOf(0)],
		refused: [refusal(true), refusal(false)],
	});
	expect(description).toContain(
		'2 selected recordings can’t be deleted right now and are kept.',
	);
});
