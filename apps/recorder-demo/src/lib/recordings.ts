/**
 * The one list the demo shows: the recordings still on this device (not
 * uploaded yet) and the ones in the repository, by id. A recording on both
 * is mid-upload; it shows as the device's until the device lets go of its
 * copy, which it does only after the server's receipt (decision 12).
 */
import type {
	FileEntryOf,
	NoteOf,
	Version,
} from '@epicenter/definition/contract';
import type { Recorder } from '../contract.ts';

type Note = NoteOf<Recorder['collections']['recordings']>;
type Audio = FileEntryOf<Recorder['collections']['audio']>;

/** What one side holds: its notes and its audio files. */
export type Listing = { notes: Note[]; audio: Audio[] };

export type RecordingRow = {
	id: string;
	/** Where the copy shown lives: still on this device, or in the repository. */
	where: 'device' | 'repository';
	/** The note, or null when only the audio is there. */
	note: {
		title: string;
		recordedAt: string;
		durationMs: number;
		version: Version;
	} | null;
	/** The audio's extension, or null when only the note is there. */
	ext: string | null;
};

function rowsOf(listing: Listing, where: RecordingRow['where']) {
	const rows = new Map<string, RecordingRow>();
	const row = (id: string) => {
		let found = rows.get(id);
		if (found === undefined) {
			found = { id, where, note: null, ext: null };
			rows.set(id, found);
		}
		return found;
	};
	for (const { id, title, recordedAt, durationMs, version } of listing.notes)
		row(id).note = { title, recordedAt, durationMs, version };
	for (const { id, ext } of listing.audio) row(id).ext = ext;
	return rows;
}

/** Device and repository recordings as one list, newest first (ids sort by time). */
export function mergeRecordings(
	device: Listing,
	repository: Listing | null,
): RecordingRow[] {
	const merged = repository ? rowsOf(repository, 'repository') : new Map();
	for (const [id, row] of rowsOf(device, 'device')) merged.set(id, row);
	return [...merged.values()].sort((a, b) =>
		a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
	);
}
