/**
 * The recordings as a collection: what each row of the table shows, which
 * rows a search keeps, what order they are in, which are selected, and what
 * the actions on several of them do.
 *
 * Everything here is read from what the library (`library.svelte.ts`)
 * lists now. Nothing is kept: the search text, the sort, the page, and the
 * selection are the library's, and are handed in. A row's identity is its
 * recording's id, so a selection survives a new sort, a new search, and a
 * turn of the page, and a recording that is gone is simply no longer
 * selected.
 *
 * The search and the sort run over every recording; the table then draws
 * one page of what they keep, so a folder of thousands of recordings draws
 * a hundred rows.
 *
 * The actions on several rows are Whispering's own actions on one row,
 * taken one at a time in table order. A transcription is asked for once for
 * each row that needs one and never asked again here; a deletion is captured
 * for each row first, as a single deletion is, and removed only as captured.
 */
import type { Deletion } from './deletion.js';
import {
	type RecordingAudio,
	type RecordingNote,
	type TranscriptionNote,
	titleOf,
} from './folder.js';
import type { Library } from './library.svelte.js';

export type RecordingStatus = 'transcribing' | 'transcribed' | 'untranscribed';

/** What the table says for each status, and the order the Status column sorts in. */
export const STATUS_LABELS: Record<RecordingStatus, string> = {
	transcribing: 'Transcribing',
	untranscribed: 'Not transcribed',
	transcribed: 'Transcribed',
};
const STATUS_ORDER = Object.keys(STATUS_LABELS) as RecordingStatus[];

type RecordingRow = {
	/** The recording's id: the row's identity in the table and the selection. */
	readonly id: string;
	readonly note: RecordingNote;
	readonly title: string;
	/** Its transcripts, newest first. */
	readonly transcripts: readonly TranscriptionNote[];
	readonly status: RecordingStatus;
	/** Where its audio is. */
	readonly audio: RecordingAudio;
};

export type RecordingSortKey = 'title' | 'recordedAt' | 'durationMs' | 'status';
export type RecordingSort = {
	readonly key: RecordingSortKey;
	readonly direction: 'asc' | 'desc';
};

/** Newest first: the order recordings are listed in when nothing else is asked. */
export const DEFAULT_SORT: RecordingSort = {
	key: 'recordedAt',
	direction: 'desc',
};

type Source = Pick<
	Library,
	'entries' | 'transcriptsFor' | 'transcribing' | 'audioOf'
>;

function statusOf(library: Source, id: string): RecordingStatus {
	if (library.transcribing(id)) return 'transcribing';
	return library.transcriptsFor(id).length > 0
		? 'transcribed'
		: 'untranscribed';
}

/** One row for every recording listed, in the list's own order. */
function recordingRows(library: Source): RecordingRow[] {
	return library.entries.map((note) => ({
		id: note.id,
		note,
		title: titleOf(note),
		transcripts: library.transcriptsFor(note.id),
		status: statusOf(library, note.id),
		audio: library.audioOf(note.id),
	}));
}

/** Whether the title, ID, notes, or any transcript of a row contains the search text. */
function matches(row: RecordingRow, needle: string): boolean {
	return [
		row.title,
		row.id,
		row.note.body,
		...row.transcripts.map((transcript) => transcript.body),
	].some((text) => text.toLowerCase().includes(needle));
}

/** The text a search looks for: two searches with the same needle keep the same rows. */
const needleOf = (query: string) => query.trim().toLowerCase();

/** The rows a search keeps. Notes that need repair are listed apart and never searched out. */
function searchRows(
	rows: readonly RecordingRow[],
	query: string,
): RecordingRow[] {
	const needle = needleOf(query);
	if (needle === '') return [...rows];
	return rows.filter((row) => matches(row, needle));
}

/** How much of a transcript a row shows. */
const EXCERPT_LENGTH = 140;
/** How much comes before the found text, so it reads in its sentence. */
const EXCERPT_LEAD = 40;

/**
 * The line of transcript a row shows. With no search it is the start of the
 * newest transcript. With a search it is the part of a transcript where the
 * text was found, newest transcript first, so the row shows why it matched;
 * a row that matched by its title or notes shows the newest transcript.
 */
export function transcriptExcerpt(
	row: RecordingRow,
	query: string,
): string | undefined {
	const needle = needleOf(query);
	const texts = row.transcripts
		.map((transcript) => transcript.body.replace(/\s+/g, ' ').trim())
		.filter((text) => text !== '');
	const newest = texts[0];
	if (newest === undefined) return undefined;
	const clip = (text: string, from: number) => {
		const start = Math.max(0, from);
		const clipped = text.slice(start, start + EXCERPT_LENGTH);
		return `${start > 0 ? '…' : ''}${clipped}${start + EXCERPT_LENGTH < text.length ? '…' : ''}`;
	};
	if (needle !== '')
		for (const text of texts) {
			const found = text.toLowerCase().indexOf(needle);
			if (found >= 0) return clip(text, found - EXCERPT_LEAD);
		}
	return clip(newest, 0);
}

/**
 * Rows in the asked order. Equal rows keep one order whatever the direction:
 * by id, which no two rows share. A row with no value for the sorted
 * column, such as an unreadable date, comes last either way.
 */
function sortRows(
	rows: readonly RecordingRow[],
	sort: RecordingSort,
): RecordingRow[] {
	const value = (row: RecordingRow): string | number | undefined => {
		switch (sort.key) {
			case 'title':
				return row.title.toLowerCase();
			case 'recordedAt':
				return row.note.recordedAt;
			case 'durationMs':
				return row.note.durationMs;
			case 'status':
				return STATUS_ORDER.indexOf(row.status);
		}
	};
	const sign = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		if (left === right) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		if (left === undefined) return 1;
		if (right === undefined) return -1;
		return (left < right ? -1 : 1) * sign;
	});
}

/** Sorting a column again reverses it; a new column starts in its natural direction. */
export function nextSort(
	current: RecordingSort,
	key: RecordingSortKey,
): RecordingSort {
	if (current.key === key)
		return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
	// Text and status read first to last; the newest and the longest come first.
	return {
		key,
		direction: key === 'title' || key === 'status' ? 'asc' : 'desc',
	};
}

/** The table as it is shown: searched, then sorted. */
export function shownRows(
	library: Source,
	query: string,
	sort: RecordingSort,
): RecordingRow[] {
	return sortRows(searchRows(recordingRows(library), query), sort);
}

// --- pages ----------------------------------------------------------------

/** How many rows one page of the table draws. */
export const PAGE_SIZE = 100;

type TablePage<TRow> = {
	/** The rows on this page, in table order. */
	readonly rows: TRow[];
	/** Which page this is, from 0. */
	readonly index: number;
	/** How many pages there are: at least one, so an empty table is one empty page. */
	readonly count: number;
	/** The first and last row on this page, counted from 1 over every page; both 0 with no rows. */
	readonly from: number;
	readonly to: number;
	/** How many rows there are on every page together. */
	readonly total: number;
};

/**
 * Page `index` of `rows`, brought into range. A page past the last is the
 * last, so deleting the rows of the last page, or a folder that shrinks,
 * shows the page before instead of an empty one.
 */
export function pageOf<TRow>(
	rows: readonly TRow[],
	index: number,
	size = PAGE_SIZE,
): TablePage<TRow> {
	const count = Math.max(1, Math.ceil(rows.length / size));
	const at = Math.min(Math.max(0, Math.trunc(index)), count - 1);
	const start = at * size;
	const onPage = rows.slice(start, start + size);
	return {
		rows: onPage,
		index: at,
		count,
		from: onPage.length > 0 ? start + 1 : 0,
		to: start + onPage.length,
		total: rows.length,
	};
}

/** What the table shows: its search, its order, and its page. */
type TableView = Pick<
	Library['ui'],
	'recordingQuery' | 'recordingSort' | 'recordingPage'
>;

/**
 * The view after `change`. A new search or a new order starts at its first
 * page, since the page the person was on now lists other recordings. The
 * same search or order set again (a space typed after the search text, the
 * sort chosen that is already chosen) keeps the page.
 */
export function viewWith(
	view: TableView,
	change: Partial<TableView>,
): TableView {
	const recordingQuery = change.recordingQuery ?? view.recordingQuery;
	const recordingSort = change.recordingSort ?? view.recordingSort;
	const changed =
		needleOf(recordingQuery) !== needleOf(view.recordingQuery) ||
		recordingSort.key !== view.recordingSort.key ||
		recordingSort.direction !== view.recordingSort.direction;
	return {
		recordingQuery,
		recordingSort,
		recordingPage: changed ? 0 : (change.recordingPage ?? view.recordingPage),
	};
}

// --- selection ------------------------------------------------------------

/**
 * The selection as it stands against the lists and the search: the selected
 * rows that are shown, in table order, and how many selected recordings the
 * search hides. A selected recording that is gone counts as neither; the
 * product drops it from the selection when a listing confirms it gone.
 * Actions apply to the shown rows only, so nothing is done to a row the
 * person cannot see.
 */
export function selectionIn(
	selected: readonly string[],
	shown: readonly RecordingRow[],
	library: Pick<Library, 'entries'>,
): { rows: RecordingRow[]; hidden: number } {
	const chosen = new Set(selected);
	const rows = shown.filter((row) => chosen.has(row.id));
	let present = 0;
	for (const note of library.entries) if (chosen.has(note.id)) present++;
	return { rows, hidden: present - rows.length };
}

/** The selection with one row added or taken out. Recordings that are gone are dropped. */
export function toggleSelected(
	selected: readonly string[],
	id: string,
	on: boolean,
	library: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(library.entries.map((note) => note.id));
	const next = selected.filter((item) => item !== id && present.has(item));
	return on && present.has(id) ? [...next, id] : next;
}

/**
 * Select or clear every row given: a page, or every row the search keeps.
 * Selected rows not given stay as they are, so clearing a page does not
 * clear the pages after it or what the search hides.
 */
export function toggleRows(
	selected: readonly string[],
	rows: readonly RecordingRow[],
	on: boolean,
	library: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(library.entries.map((note) => note.id));
	const given = new Set(rows.map((row) => row.id));
	const kept = selected.filter((item) => present.has(item) && !given.has(item));
	return on ? [...kept, ...given] : kept;
}

/**
 * The selection after a shift-click on row `id` of a page: every row from
 * the last row clicked, `anchor`, to this one is ticked or cleared, as this
 * one now is. A range stays on one page; with no anchor on this page only
 * this row changes.
 */
export function selectRange(
	selected: readonly string[],
	page: readonly RecordingRow[],
	anchor: string | undefined,
	id: string,
	on: boolean,
	library: Pick<Library, 'entries'>,
): string[] {
	const to = page.findIndex((row) => row.id === id);
	const from = page.findIndex((row) => row.id === anchor);
	if (to < 0 || from < 0) return toggleSelected(selected, id, on, library);
	const range = page.slice(Math.min(from, to), Math.max(from, to) + 1);
	return toggleRows(selected, range, on, library);
}

/**
 * How much of the table the selection covers, as a mail client tells it.
 * `'all'` when every row the search keeps is selected and they fill more
 * than one page; `'page'` when every row on this page is selected and more
 * rows match, which is when the table offers to select them all.
 */
export function selectionReach(
	selected: ReadonlySet<string>,
	page: Pick<TablePage<RecordingRow>, 'rows' | 'count'>,
	shown: readonly RecordingRow[],
): 'all' | 'page' | undefined {
	if (page.count < 2) return undefined;
	if (!page.rows.every((row) => selected.has(row.id))) return undefined;
	return shown.every((row) => selected.has(row.id)) ? 'all' : 'page';
}

// --- actions on several rows ---------------------------------------------

/**
 * The newest transcript of each row as one text to copy, in the order given.
 * One row copies as its text alone; several are each headed by their title,
 * so the copy can be told apart. Rows with no transcript text are left out
 * and counted.
 */
export function transcriptsToCopy(rows: readonly RecordingRow[]): {
	text: string;
	copied: number;
	without: number;
} {
	const parts = rows.flatMap((row) => {
		const text = row.transcripts[0]?.body.trim();
		return text ? [{ title: row.title, text }] : [];
	});
	return {
		text:
			parts.length === 1
				? (parts[0]?.text ?? '')
				: parts.map(({ title, text }) => `${title}\n${text}`).join('\n\n'),
		copied: parts.length,
		without: rows.length - parts.length,
	};
}

type BulkTranscription = {
	/** Recordings whose transcript was received and saved. */
	readonly transcribed: string[];
	/** Recordings that were not sent, with why. */
	readonly skipped: { readonly title: string; readonly reason: string }[];
	/** Recordings that were sent, or tried, and have no saved transcript. */
	readonly failed: { readonly title: string; readonly reason: string }[];
};

/**
 * Transcribe the rows that have no transcript, one at a time in the order
 * given. Each is Whispering's own transcription of that row, sent once. A
 * row that already has a transcript, has no audio it can read, or has a
 * transcription under way is not sent. Nothing is sent again here after a
 * failure: trying again is the person's choice. Once Whispering is closing,
 * the rows still waiting are not sent.
 */
export async function transcribeRows(
	library: Source & Pick<Library, 'transcribe' | 'closing'>,
	ids: readonly string[],
	onProgress?: (done: number) => void,
): Promise<BulkTranscription> {
	const outcome: BulkTranscription = {
		transcribed: [],
		skipped: [],
		failed: [],
	};
	let done = 0;
	// What each row is called when the run starts, for a row no longer listed by its turn.
	const titles = new Map(
		library.entries.map((note) => [note.id, titleOf(note)]),
	);
	for (const id of ids) {
		// Read again for each row: the lists may have changed while the last one ran.
		const note = library.entries.find((item) => item.id === id);
		const title = note ? titleOf(note) : (titles.get(id) ?? id);
		const skip = (reason: string) => outcome.skipped.push({ title, reason });
		const status = note && statusOf(library, id);
		const audio = note && library.audioOf(id);
		if (library.closing) skip('The app was closing, so it was not sent.');
		else if (note === undefined) skip('It is no longer listed.');
		else if (status === 'transcribing')
			skip('It is already being transcribed.');
		else if (status === 'transcribed') skip('It already has a transcript.');
		else if (audio?.kind === 'ambiguous')
			skip('More than one audio file has its id. Keep one.');
		else if (audio?.kind !== 'here') skip('Its audio cannot be read here.');
		else {
			const { error } = await library.transcribe(id);
			if (error === null) outcome.transcribed.push(title);
			else outcome.failed.push({ title, reason: error.message });
		}
		onProgress?.(++done);
	}
	return outcome;
}

type CapturedDeletions = {
	/** What each deletion would remove, captured as a single deletion is. */
	readonly deletions: Extract<Deletion, { kind: 'recording' }>[];
	/** Recordings that cannot be deleted now, with Whispering's own reason. */
	readonly refused: { readonly title: string; readonly reason: string }[];
};

/**
 * Capture a deletion for each recording, in the order given, before anyone
 * is asked. Each is Whispering's own capture, so a recording with work
 * under way, or with transcripts that cannot be
 * told apart from its own, is refused with that reason and left out.
 */
export function captureDeletions(
	library: Pick<Library, 'deletionFor' | 'entries'>,
	ids: readonly string[],
): CapturedDeletions {
	const captured: CapturedDeletions = { deletions: [], refused: [] };
	for (const id of ids) {
		const note = library.entries.find((item) => item.id === id);
		const title = note ? titleOf(note) : id;
		const { data: deletion, error: refusal } = library.deletionFor({
			collection: 'recordings',
			id,
		});
		if (refusal !== null) captured.refused.push({ title, reason: refusal });
		else if (deletion.kind === 'recording') captured.deletions.push(deletion);
		else captured.refused.push({ title, reason: 'It is not a recording.' });
	}
	return captured;
}

const count = (n: number, one: string, many: string) =>
	`${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A few of `names`, then how many more, so a long list still reads. */
const fewOf = (names: readonly string[], shown = 3) =>
	names.length > shown
		? `${names.slice(0, shown).join(', ')} and ${(names.length - shown).toLocaleString()} more`
		: names.join(', ');

/** What the person is told before several recordings are deleted: what goes, what stays, and what was left out. */
export function describeDeletions({ deletions, refused }: CapturedDeletions): {
	title: string;
	description: string;
} {
	const transcripts = deletions.reduce(
		(sum, item) => sum + item.transcripts.length,
		0,
	);
	const names = fewOf(deletions.map((item) => `“${item.title}”`));
	const their = deletions.length === 1 ? 'its' : 'their';
	return {
		title: `Delete ${count(deletions.length, 'recording', 'recordings')}${
			transcripts > 0
				? ` and ${their} ${count(transcripts, 'transcript', 'transcripts')}`
				: ''
		}?`,
		description: `This also deletes ${their} audio: ${names}.${
			refused.length > 0
				? ` ${count(refused.length, 'selected recording is', 'selected recordings are')} left out and kept: ${fewOf(
						refused.map(({ title, reason }) => `“${title}” (${reason})`),
					)}.`
				: ''
		}`,
	};
}

/**
 * Delete exactly what was captured and confirmed, one recording at a time.
 * Each is Whispering's own deletion, so a recording with work under way, or
 * a transcript saved since it was captured, is refused there and reported here;
 * the rest still go.
 */
export async function deleteCaptured(
	library: Pick<Library, 'delete'>,
	deletions: CapturedDeletions['deletions'],
): Promise<{ deleted: number; problems: { title: string; reason: string }[] }> {
	let deleted = 0;
	const problems: { title: string; reason: string }[] = [];
	for (const deletion of deletions) {
		const problem = await library.delete(deletion);
		if (problem === undefined) deleted += 1;
		else problems.push({ title: deletion.title, reason: problem });
	}
	return { deleted, problems };
}
