/**
 * The recordings one view shows: one client's notes and audio files, this
 * device's or the repository's (decision 76), joined by id. A recording is
 * a note and its audio at the same id; either may be there without the
 * other (a save that stopped partway, or a file another program wrote).
 */
import type {
	FileEntryOf,
	NoteOf,
	Version,
} from '@epicenter/definition/contract';
import type { Recorder } from '../contract.ts';

type Note = NoteOf<Recorder['collections']['recordings']>;
type Audio = FileEntryOf<Recorder['collections']['audio']>;

/** What one client holds: its notes and its audio files. */
export type Listing = { notes: readonly Note[]; audio: readonly Audio[] };

export type RecordingRow = {
	id: string;
	/** The note, or null when only the audio is there. */
	note: {
		title: string;
		recordedAt: string;
		durationMs: number;
		version: Version;
	} | null;
	/** The audio's extension, or null when only the note is there. */
	ext: string | null;
	/** The audio's version on its client, or null when only the note is there. */
	audioVersion: Version | null;
};

/** One client's recordings, newest first (ids sort by time). */
export function recordingsOf(listing: Listing): RecordingRow[] {
	const rows = new Map<string, RecordingRow>();
	const row = (id: string) => {
		let found = rows.get(id);
		if (found === undefined) {
			found = { id, note: null, ext: null, audioVersion: null };
			rows.set(id, found);
		}
		return found;
	};
	for (const { id, title, recordedAt, durationMs, version } of listing.notes)
		row(id).note = { title, recordedAt, durationMs, version };
	for (const { id, ext, version } of listing.audio) {
		row(id).ext = ext;
		row(id).audioVersion = version;
	}
	return [...rows.values()].sort((a, b) =>
		a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
	);
}
