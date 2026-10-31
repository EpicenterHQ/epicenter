/**
 * The one list the demo shows: the recordings still on this device (not
 * uploaded yet) and the ones in the repository, by id. A recording on both
 * is mid-upload; it shows as the device's until the device lets go of its
 * copy, which it does only after the server's reply shows it landed
 * (decision 12).
 *
 * A recording this device uploaded keeps its audio in the device's cache
 * (decision 66), so its row is marked cached and plays without the network.
 * When the repository cannot be listed (offline), the cached audio still
 * shows, as rows of their own.
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
export type Listing = { notes: readonly Note[]; audio: readonly Audio[] };

/** An audio file the device cached after uploading it. */
export type Cached = { id: string; ext: string };

export type RecordingRow = {
	id: string;
	/**
	 * Where the copy shown lives: still on this device, in the repository,
	 * or (when the repository cannot be listed) only in the device's cache.
	 */
	where: 'device' | 'repository' | 'cache';
	/** The note, or null when only the audio is there. */
	note: {
		title: string;
		recordedAt: string;
		durationMs: number;
		version: Version;
	} | null;
	/** The audio's extension, or null when only the note is there. */
	ext: string | null;
	/** The repository's version of the audio, which a cached copy must be; null when unknown. */
	audioVersion: Version | null;
	/** Whether the device's cache holds this recording's audio. */
	cached: boolean;
};

function rowsOf(listing: Listing, where: RecordingRow['where']) {
	const rows = new Map<string, RecordingRow>();
	const row = (id: string) => {
		let found = rows.get(id);
		if (found === undefined) {
			found = {
				id,
				where,
				note: null,
				ext: null,
				audioVersion: null,
				cached: false,
			};
			rows.set(id, found);
		}
		return found;
	};
	for (const { id, title, recordedAt, durationMs, version } of listing.notes)
		row(id).note = { title, recordedAt, durationMs, version };
	for (const { id, ext, version } of listing.audio) {
		row(id).ext = ext;
		if (where === 'repository') row(id).audioVersion = version;
	}
	return rows;
}

/**
 * Device and repository recordings as one list, newest first (ids sort by
 * time), with the cached audio marked; `repository` is null when it cannot
 * be listed, and then the cached audio shows on its own.
 */
export function mergeRecordings(
	device: Listing,
	repository: Listing | null,
	cached: readonly Cached[] = [],
): RecordingRow[] {
	const merged = repository ? rowsOf(repository, 'repository') : new Map();
	for (const { id, ext } of cached) {
		const row = merged.get(id);
		if (row?.ext === ext) row.cached = true;
		else if (repository === null)
			merged.set(id, {
				id,
				where: 'cache',
				note: null,
				ext,
				audioVersion: null,
				cached: true,
			});
	}
	for (const [id, row] of rowsOf(device, 'device')) merged.set(id, row);
	return [...merged.values()].sort((a, b) =>
		a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
	);
}
