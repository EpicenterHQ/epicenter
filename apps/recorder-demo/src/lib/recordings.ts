/**
 * The recordings one client holds, this browser's files or the repository
 * (whichever the page's variant opened): its notes and audio files joined
 * by id. A recording is a note and its audio at the same id; either may be
 * there without the other (a recording still under way, one a closed tab
 * cut off, a save that stopped partway, or a file another program wrote).
 */
import type {
	Client,
	FileEntryOf,
	NoteOf,
	Version,
} from '@epicenter/definition/contract';
import { audioDurationMs } from '@epicenter/recorder';
import { Err, Ok, type Result } from 'wellcrafted/result';
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
};

/** One client's recordings, newest first (ids sort by time). */
export function recordingsOf(listing: Listing): RecordingRow[] {
	const rows = new Map<string, RecordingRow>();
	const row = (id: string) => {
		let found = rows.get(id);
		if (found === undefined) {
			found = { id, note: null, ext: null };
			rows.set(id, found);
		}
		return found;
	};
	for (const { id, title, recordedAt, durationMs, version } of listing.notes)
		row(id).note = { title, recordedAt, durationMs, version };
	for (const { id, ext } of listing.audio) row(id).ext = ext;
	return [...rows.values()].sort((a, b) =>
		a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
	);
}

/** When the recording `id` (a `timeId`) was made, or undefined for an id that is not one. */
function recordedAtOf(id: string): Date | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(
		id,
	);
	if (match === null) return undefined;
	const [, day, hours, minutes, seconds, millis] = match;
	const at = new Date(`${day}T${hours}:${minutes}:${seconds}.${millis}Z`);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

/**
 * Make the note of each recording whose audio a closed tab or a crash left
 * without one, its length read from the audio itself. The local variant
 * runs it when it opens, after `recoverRecordings` cut the audio back to its
 * last whole piece. Answers the ids it finished; audio that does not read,
 * or whose id is not a recording's, is left as it is.
 */
export async function finishCutOffRecordings(
	device: Client<Recorder>,
): Promise<Result<string[], string>> {
	const [notes, audio] = await Promise.all([
		device.recordings.list(),
		device.audio.list(),
	]);
	if (notes.error !== null) return Err(notes.error.message);
	if (audio.error !== null) return Err(audio.error.message);
	// A note that does not read still names its recording.
	const named = new Set<string>(
		[...notes.data.items, ...notes.data.invalid].map(({ id }) => id),
	);
	const finished: string[] = [];
	for (const { id, ext } of audio.data.items) {
		const recordedAt = recordedAtOf(id);
		if (named.has(id) || recordedAt === undefined) continue;
		const read = await device.audio.get({ id, ext });
		if (read.error !== null) continue;
		const durationMs = audioDurationMs(read.data.bytes, ext);
		if (durationMs === undefined) continue;
		const created = await device.recordings.create({
			id,
			title: `Recording ${recordedAt.toLocaleString()}`,
			recordedAt: recordedAt.toISOString(),
			durationMs,
		});
		if (created.error === null) finished.push(id);
	}
	return Ok(finished);
}
