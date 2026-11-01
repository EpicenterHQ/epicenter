/**
 * The recordings as a collection: what each row of the table shows, which
 * rows a search keeps, what order they are in, which are selected, and what
 * the actions on several of them do.
 *
 * Everything here is read from what the library (`library.svelte.ts`)
 * lists now. Nothing is kept: the search text, the sort, and the selection
 * are the library's, and are handed in. A row's identity is its recording's
 * id, so a selection survives a new sort and a new search, and a recording
 * that is gone is simply no longer selected.
 *
 * The actions on several rows are Whispering's own actions on one row,
 * taken one at a time in table order. A transcription is asked for once for
 * each row that needs one and never asked again here; a deletion is captured
 * for each row first, as a single deletion is, and removed only as captured.
 */
import { type Deletion, titleOf } from './deletion.js';
import type {
	RecordingAudio,
	RecordingNote,
	TranscriptionNote,
} from './files.svelte.js';
import type { Library } from './library.svelte.js';

export type RecordingStatus =
	| 'transcribing'
	| 'failed'
	| 'transcribed'
	| 'untranscribed';

/** What the table says for each status, and the order the Status column sorts in. */
export const STATUS_LABELS: Record<RecordingStatus, string> = {
	failed: 'Transcription failed',
	transcribing: 'Transcribing',
	untranscribed: 'Not transcribed',
	transcribed: 'Transcribed',
};
const STATUS_ORDER = Object.keys(STATUS_LABELS) as RecordingStatus[];

export type RecordingRow = {
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
	'entries' | 'resultsFor' | 'transcriptionRun' | 'audioOf'
>;

function statusOf(whispering: Source, id: string): RecordingStatus {
	const state = whispering.transcriptionRun(id)?.state;
	if (
		state?.kind === 'running' ||
		(state?.kind === 'unsaved' && state.message === undefined)
	)
		return 'transcribing';
	if (state !== undefined) return 'failed';
	return whispering.resultsFor(id).length > 0 ? 'transcribed' : 'untranscribed';
}

/** One row for every recording listed, in the list's own order. */
export function recordingRows(whispering: Source): RecordingRow[] {
	return whispering.entries.map((note) => ({
		id: note.id,
		note,
		title: titleOf(note),
		transcripts: whispering.resultsFor(note.id),
		status: statusOf(whispering, note.id),
		audio: whispering.audioOf(note.id),
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

/** The rows a search keeps. Notes that need repair are listed apart and never searched out. */
export function searchRows(
	rows: readonly RecordingRow[],
	query: string,
): RecordingRow[] {
	const needle = query.trim().toLowerCase();
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
	const needle = query.trim().toLowerCase();
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
export function sortRows(
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
	whispering: Source,
	query: string,
	sort: RecordingSort,
): RecordingRow[] {
	return sortRows(searchRows(recordingRows(whispering), query), sort);
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
	whispering: Pick<Library, 'entries'>,
): { rows: RecordingRow[]; hidden: number } {
	const chosen = new Set(selected);
	const rows = shown.filter((row) => chosen.has(row.id));
	let present = 0;
	for (const note of whispering.entries) if (chosen.has(note.id)) present++;
	return { rows, hidden: present - rows.length };
}

/** The selection with one row added or taken out. Recordings that are gone are dropped. */
export function toggleSelected(
	selected: readonly string[],
	id: string,
	on: boolean,
	whispering: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(whispering.entries.map((note) => note.id));
	const next = selected.filter((item) => item !== id && present.has(item));
	return on && present.has(id) ? [...next, id] : next;
}

/**
 * Select or clear every shown row. Selected rows the search hides stay as
 * they are: clearing what is on screen does not clear what is not.
 */
export function toggleAllShown(
	selected: readonly string[],
	shown: readonly RecordingRow[],
	on: boolean,
	whispering: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(whispering.entries.map((note) => note.id));
	const visible = new Set(shown.map((row) => row.id));
	const kept = selected.filter(
		(item) => present.has(item) && !visible.has(item),
	);
	return on ? [...kept, ...visible] : kept;
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

export type BulkTranscription = {
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
	whispering: Source & Pick<Library, 'transcribe' | 'closing'>,
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
		whispering.entries.map((note) => [note.id, titleOf(note)]),
	);
	for (const id of ids) {
		// Read again for each row: the lists may have changed while the last one ran.
		const note = whispering.entries.find((item) => item.id === id);
		const title = note ? titleOf(note) : (titles.get(id) ?? id);
		const skip = (reason: string) => outcome.skipped.push({ title, reason });
		const status = note && statusOf(whispering, id);
		const audio = note && whispering.audioOf(id);
		if (whispering.closing) skip('The app was closing, so it was not sent.');
		else if (note === undefined) skip('It is no longer listed.');
		else if (status === 'transcribing')
			skip('It is already being transcribed.');
		else if (status === 'transcribed') skip('It already has a transcript.');
		else if (audio?.kind === 'ambiguous')
			skip('More than one audio file has its id. Keep one.');
		else if (audio?.kind !== 'here') skip('Its audio cannot be read here.');
		else {
			const refused = await whispering.transcribe(id);
			const state = whispering.transcriptionRun(id)?.state;
			if (whispering.resultsFor(id).length > 0) outcome.transcribed.push(title);
			else
				outcome.failed.push({
					title,
					reason:
						refused ??
						(state?.kind === 'failed'
							? state.message
							: state?.kind === 'unsaved' && state.message !== undefined
								? `Its answer arrived, but could not be saved yet: ${state.message}`
								: 'No transcript is listed for it. Open the recording to see why.'),
				});
		}
		onProgress?.(++done);
	}
	return outcome;
}

export type CapturedDeletions = {
	/** What each deletion would remove, captured as a single deletion is. */
	readonly deletions: Extract<Deletion, { kind: 'recording' }>[];
	/** Recordings that cannot be deleted now, with Whispering's own reason. */
	readonly refused: { readonly title: string; readonly reason: string }[];
};

/**
 * Capture a deletion for each recording, in the order given, before anyone
 * is asked. Each is Whispering's own capture, so a recording with work
 * under way, or with results that cannot be
 * told apart from its own, is refused with that reason and left out.
 */
export async function captureDeletions(
	whispering: Pick<Library, 'deletionFor' | 'entries'>,
	ids: readonly string[],
): Promise<CapturedDeletions> {
	const captured: CapturedDeletions = { deletions: [], refused: [] };
	for (const id of ids) {
		const note = whispering.entries.find((item) => item.id === id);
		const title = note ? titleOf(note) : id;
		const { data: deletion, error: refusal } = whispering.deletionFor({
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
	`${n} ${n === 1 ? one : many}`;

/** What the person is told before several recordings are deleted: what goes, what stays, and what was left out. */
export function describeDeletions({ deletions, refused }: CapturedDeletions): {
	title: string;
	description: string;
} {
	const results = deletions.reduce((sum, item) => sum + item.results.length, 0);
	const removed = [
		count(deletions.length, 'recording', 'recordings'),
		'their audio',
		...(results > 0 ? [count(results, 'result', 'results')] : []),
	];
	const names = deletions.map((item) => `“${item.title}”`).join(', ');
	return {
		title: `Delete ${count(deletions.length, 'recording', 'recordings')}?`,
		description: `This deletes ${removed.join(', ')}: ${names}.${
			refused.length > 0
				? ` ${count(refused.length, 'selected recording is', 'selected recordings are')} left out and kept: ${refused
						.map(({ title, reason }) => `“${title}” (${reason})`)
						.join(' ')}`
				: ''
		}`,
	};
}

/**
 * Delete exactly what was captured and confirmed, one recording at a time.
 * Each is Whispering's own deletion, so a recording with work under way, or
 * a result saved since it was captured, is refused there and reported here;
 * the rest still go.
 */
export async function deleteCaptured(
	whispering: Pick<Library, 'delete'>,
	deletions: CapturedDeletions['deletions'],
): Promise<{ deleted: number; problems: { title: string; reason: string }[] }> {
	let deleted = 0;
	const problems: { title: string; reason: string }[] = [];
	for (const deletion of deletions) {
		const problem = await whispering.delete(deletion);
		if (problem === undefined) deleted += 1;
		else problems.push({ title: deletion.title, reason: problem });
	}
	return { deleted, problems };
}
