/**
 * The recordings as a collection: what each row of the table shows, which
 * rows a search keeps, what order they are in, which are selected, and what
 * the actions on several of them do.
 *
 * Everything here is read from the library's current observation of the
 * folder. Nothing is kept: the search text, the sort, and the selection are
 * the session's, and are handed in. A row's identity is its file path, so a
 * selection survives a new sort, a new search, and a refresh, and a path
 * that has left the folder is simply no longer selected.
 *
 * The actions on several rows are the library's own actions on one row,
 * taken one at a time in table order. A transcription is asked for once for
 * each row that needs one and never asked again here; a deletion is captured
 * for each row first, as a single deletion is, and removed only as captured.
 */
import { audioPathIn } from './definition.js';
import { recordingTitle } from './deletion.js';
import type {
	Deletion,
	Library,
	RecordingEntry,
	TranscriptionEntry,
} from './library.svelte.js';

export type RecordingStatus =
	| 'transcribing'
	| 'failed'
	| 'unsaved'
	| 'transcribed'
	| 'untranscribed';

/** What the table says for each status, and the order the Status column sorts in. */
export const STATUS_LABELS: Record<RecordingStatus, string> = {
	failed: 'Transcription failed',
	unsaved: 'Transcript not saved',
	transcribing: 'Transcribing',
	untranscribed: 'Not transcribed',
	transcribed: 'Transcribed',
};
const STATUS_ORDER = Object.keys(STATUS_LABELS) as RecordingStatus[];

export type RecordingRow = {
	/** The row file's path: the row's identity in the table and the selection. */
	readonly path: string;
	readonly entry: RecordingEntry;
	readonly title: string;
	/** Saved transcripts, newest first. */
	readonly transcripts: readonly TranscriptionEntry[];
	readonly status: RecordingStatus;
};

export type RecordingSortKey = 'title' | 'recordedAt' | 'durationMs' | 'status';
export type RecordingSort = {
	readonly key: RecordingSortKey;
	readonly direction: 'asc' | 'desc';
};

/** Newest first: the order the folder's recordings are listed in when nothing else is asked. */
export const DEFAULT_SORT: RecordingSort = {
	key: 'recordedAt',
	direction: 'desc',
};

type Source = Pick<Library, 'entries' | 'resultsFor' | 'transcriptionRun'>;

function statusOf(
	transcripts: readonly TranscriptionEntry[],
	run: ReturnType<Library['transcriptionRun']>,
): RecordingStatus {
	if (run?.kind === 'running') return 'transcribing';
	if (run?.kind === 'unsaved') return 'unsaved';
	if (run?.kind === 'failed') return 'failed';
	return transcripts.length > 0 ? 'transcribed' : 'untranscribed';
}

/** One row for every recording the folder lists, in the folder's own order. */
export function recordingRows(library: Source): RecordingRow[] {
	return library.entries.map((entry) => {
		const transcripts = library.resultsFor(entry.stem);
		return {
			path: entry.path,
			entry,
			title: recordingTitle(entry),
			transcripts,
			status: statusOf(transcripts, library.transcriptionRun(entry.stem)),
		};
	});
}

/** Whether the title, ID, notes, or any transcript of a row contains the search text. */
function matches(row: RecordingRow, needle: string): boolean {
	return [
		row.title,
		row.entry.stem,
		row.entry.row.body,
		...row.transcripts.map((transcript) => transcript.row.body),
	].some((text) => text.toLowerCase().includes(needle));
}

/** The rows a search keeps. Files that need repair are listed apart and never searched out. */
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
		.map((transcript) => transcript.row.body.replace(/\s+/g, ' ').trim())
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
 * by path, which no two rows share. A row with no value for the sorted
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
				return row.entry.row.fields.recordedAt;
			case 'durationMs':
				return row.entry.row.fields.durationMs;
			case 'status':
				return STATUS_ORDER.indexOf(row.status);
		}
	};
	const sign = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const left = value(a);
		const right = value(b);
		if (left === right) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
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

// --- selection ------------------------------------------------------------

/**
 * The selection as it stands against the folder and the search: the selected
 * rows that are shown, in table order, and how many selected recordings the
 * search hides. A selected path that has left the folder counts as neither;
 * the session drops it from the selection when a listing confirms it gone.
 * Actions apply to the shown rows only, so nothing is done to a row the
 * person cannot see.
 */
export function selectionIn(
	selected: readonly string[],
	shown: readonly RecordingRow[],
	library: Pick<Library, 'entries'>,
): { rows: RecordingRow[]; hidden: number } {
	const chosen = new Set(selected);
	const rows = shown.filter((row) => chosen.has(row.path));
	let present = 0;
	for (const entry of library.entries) if (chosen.has(entry.path)) present++;
	return { rows, hidden: present - rows.length };
}

/** The selection with one row added or taken out. Paths that left the folder are dropped. */
export function toggleSelected(
	selected: readonly string[],
	path: string,
	on: boolean,
	library: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(library.entries.map((entry) => entry.path));
	const next = selected.filter((item) => item !== path && present.has(item));
	return on && present.has(path) ? [...next, path] : next;
}

/**
 * Select or clear every shown row. Selected rows the search hides stay as
 * they are: clearing what is on screen does not clear what is not.
 */
export function toggleAllShown(
	selected: readonly string[],
	shown: readonly RecordingRow[],
	on: boolean,
	library: Pick<Library, 'entries'>,
): string[] {
	const present = new Set(library.entries.map((entry) => entry.path));
	const visible = new Set(shown.map((row) => row.path));
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
		const text = row.transcripts[0]?.row.body.trim();
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
 * given. Each is the library's own transcription of that row: only the audio
 * its file names is sent, once. A row that already has a transcript, names
 * no audio, or has a transcription under way or unsaved is not sent. Nothing
 * is sent again here after a failure: trying again is the person's choice.
 * Once the library is closing, the rows still waiting are not sent; the one
 * already sent ends as it would have and is reported as it ended.
 */
export async function transcribeRows(
	library: Pick<
		Library,
		'entries' | 'resultsFor' | 'transcriptionRun' | 'transcribe' | 'closing'
	>,
	paths: readonly string[],
	onProgress?: (done: number) => void,
): Promise<BulkTranscription> {
	const outcome: BulkTranscription = {
		transcribed: [],
		skipped: [],
		failed: [],
	};
	let done = 0;
	for (const path of paths) {
		// Read again for each row: the folder may have changed while the last one ran.
		const entry = library.entries.find((item) => item.path === path);
		const title = entry ? recordingTitle(entry) : path;
		const skip = (reason: string) => outcome.skipped.push({ title, reason });
		const before = entry && library.transcriptionRun(entry.stem)?.kind;
		// Asked before every row: a row still waiting its turn when the app
		// began closing is not sent, and says so.
		if (library.closing) skip('The app was closing, so it was not sent.');
		else if (entry === undefined) skip('It is no longer in the folder.');
		else if (library.resultsFor(entry.stem).length > 0)
			skip('It already has a transcript.');
		else if (audioPathIn(entry.row.fields) === undefined)
			skip('Its file names no audio.');
		else if (before === 'running') skip('It is already being transcribed.');
		else if (before === 'unsaved')
			skip('A transcript of it arrived and is not saved yet.');
		else {
			await library.transcribe(entry);
			// Counted by what the folder lists now, not by the call having returned:
			// the library declines without a word when the recording is on its way out.
			const run = library.transcriptionRun(entry.stem);
			if (library.resultsFor(entry.stem).length > 0)
				outcome.transcribed.push(title);
			else
				outcome.failed.push({
					title,
					reason:
						run !== undefined && run.kind !== 'running'
							? run.message
							: 'No transcript is listed for it. Open the recording to see why.',
				});
		}
		onProgress?.(++done);
	}
	return outcome;
}

export type CapturedDeletions = {
	/** What each deletion would remove, captured as a single deletion is. */
	readonly deletions: Extract<Deletion, { kind: 'recording' }>[];
	/** Recordings that cannot be deleted now, with the library's own reason. */
	readonly refused: { readonly title: string; readonly reason: string }[];
};

/**
 * Capture a deletion for each recording, in the order given, before anyone
 * is asked. Each is the library's own capture, so pending typing is saved
 * first and a recording with work under way, or with results that cannot be
 * told apart from its own, is refused with that reason and left out.
 */
export async function captureDeletions(
	library: Pick<Library, 'deletionFor' | 'entries'>,
	paths: readonly string[],
): Promise<CapturedDeletions> {
	const captured: CapturedDeletions = { deletions: [], refused: [] };
	for (const path of paths) {
		const entry = library.entries.find((item) => item.path === path);
		const title = entry ? recordingTitle(entry) : path;
		const { data: deletion, error: refusal } = await library.deletionFor(path);
		if (refusal !== null) captured.refused.push({ title, reason: refusal });
		else if (deletion.kind === 'recording') captured.deletions.push(deletion);
		else
			captured.refused.push({
				title,
				reason:
					deletion.kind === 'file' && deletion.problem !== undefined
						? `Its file does not read as a recording (${deletion.problem}). Delete it on its own from its page or Files.`
						: 'It is not a recording.',
			});
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
	const audio = deletions.filter((item) => item.audioPath !== undefined).length;
	const removed = [
		count(deletions.length, 'recording file', 'recording files'),
		...(results > 0 ? [count(results, 'result', 'results')] : []),
	];
	const names = deletions.map((item) => `“${item.title}”`).join(', ');
	return {
		title: `Delete ${count(deletions.length, 'recording', 'recordings')}?`,
		description: `This deletes ${removed.join(', ')} from the folder: ${names}. ${
			audio > 0
				? `${audio === 1 ? 'The audio file is' : `The ${audio} audio files are`} not deleted: audio stays in the folder as ordinary files, and you can delete it from Files. `
				: ''
		}${
			deletions.some((item) => item.unversioned)
				? 'Some have changes that are in no saved version, and those are lost. Earlier saved versions stay in Git history.'
				: 'Saved versions stay in Git history.'
		}${
			refused.length > 0
				? ` ${count(refused.length, 'selected recording is', 'selected recordings are')} left out and kept: ${refused
						.map(({ title, reason }) => `“${title}” (${reason})`)
						.join(' ')}`
				: ''
		}`,
	};
}

/**
 * Remove exactly what was captured and confirmed, one recording at a time.
 * Each is the library's own removal, so a recording that changed since it
 * was captured is refused there and reported here; the rest still go.
 */
export async function removeCaptured(
	library: Pick<Library, 'remove'>,
	deletions: CapturedDeletions['deletions'],
): Promise<{ removed: number; problems: { title: string; reason: string }[] }> {
	let removed = 0;
	const problems: { title: string; reason: string }[] = [];
	for (const deletion of deletions) {
		const problem = await library.remove(deletion);
		if (problem === undefined) removed += 1;
		else problems.push({ title: deletion.title, reason: problem });
	}
	return { removed, problems };
}
