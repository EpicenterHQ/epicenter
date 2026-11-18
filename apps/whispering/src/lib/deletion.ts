/**
 * Deleting: capture what a deletion removes from what the lists show, tell
 * the person exactly that, and delete those files.
 *
 * Deleting a recording removes its note, its audio, and its transcripts, in
 * Whispering's files. It is refused while it is being transcribed, and
 * while a transcript does not read, since it might be this recording's.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	audioOf,
	describeIssues,
	type FolderSnapshot,
	type NoteRef,
	notePath,
	type RecordingAudio,
	titleOf,
	unnotedOf,
} from './folder.js';

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'recording';
			readonly id: string;
			readonly title: string;
			/** Whether it has a note; a recording may be its audio alone. */
			readonly noted: boolean;
			/** Its audio file, when one is listed. */
			readonly audio: string | undefined;
			/** Its transcripts. */
			readonly results: readonly NoteRef[];
	  }
	| {
			/** One transcript. */
			readonly kind: 'result';
			readonly note: NoteRef;
	  }
	| {
			/** A note that does not read; only it goes. */
			readonly kind: 'invalid';
			readonly note: NoteRef;
			readonly problem: string;
	  };

/** The recording a deletion removes, if it removes one. */
export const recordingDeleted = (deletion: Deletion) =>
	deletion.kind === 'recording'
		? deletion.id
		: deletion.kind === 'invalid' && deletion.note.collection === 'recordings'
			? deletion.note.id
			: undefined;

/** The note a deletion is of: a recording, or one note. */
export const deletedNote = (deletion: Deletion): NoteRef =>
	deletion.kind === 'recording'
		? { collection: 'recordings', id: deletion.id }
		: deletion.note;

/** Where a recording's audio file is, as the person is told it. */
function audioPath(id: string, audio: RecordingAudio) {
	return audio.kind === 'here'
		? `recordings/${id}.${audio.file.ext}`
		: audio.kind === 'ambiguous'
			? audio.exts.map((ext) => `recordings/${id}.${ext}`).join(', ')
			: undefined;
}

/**
 * Every transcript naming recording `id`. Refused while any transcript
 * does not read, since it might be this recording's.
 */
function resultsOf(
	snapshot: FolderSnapshot,
	id: string,
): Result<NoteRef[], string> {
	const unknown = snapshot.transcriptions.invalid.map((note) => note.path);
	if (unknown.length > 0)
		return Err(
			`Some transcripts cannot be told apart from this recording’s, because they do not read: ${unknown.join(', ')}. Repair or delete them first, so none is left naming a recording that is gone.`,
		);
	return Ok(
		snapshot.transcriptions.items
			.filter((note) => note.recordingId === id)
			.map((note) => ({ collection: 'transcriptions' as const, id: note.id })),
	);
}

/**
 * Capture what deleting `note` would remove, for the person to confirm.
 * Capturing changes nothing.
 */
export function captureDeletion(
	{
		snapshot,
		busy,
	}: {
		/** The folder as the lists show it. */
		readonly snapshot: FolderSnapshot;
		/** Why a recording cannot be deleted now, while work for it is under way. */
		busy(recordingId: string): string | undefined;
	},
	note: NoteRef,
): Result<Deletion, string> {
	const invalid = snapshot[note.collection].invalid.find(
		(item) => item.id === note.id,
	);
	if (invalid !== undefined) {
		if (note.collection === 'recordings') {
			const why = busy(note.id);
			if (why !== undefined) return Err(why);
		}
		return Ok({
			kind: 'invalid',
			note,
			problem: describeIssues(invalid.issues),
		});
	}
	switch (note.collection) {
		case 'recordings': {
			const why = busy(note.id);
			if (why !== undefined) return Err(why);
			const noted = snapshot.recordings.items.find(
				(item) => item.id === note.id,
			);
			const recording =
				noted ?? unnotedOf(snapshot).find((item) => item.id === note.id);
			if (recording === undefined)
				return Err('This recording is no longer listed.');
			const { data: results, error } = resultsOf(snapshot, note.id);
			if (error !== null) return Err(error);
			return Ok({
				kind: 'recording',
				id: note.id,
				title: titleOf(recording),
				noted: noted !== undefined,
				audio: audioPath(note.id, audioOf(snapshot, note.id)),
				results,
			});
		}
		default: {
			const items: readonly { id: string }[] = snapshot[note.collection].items;
			if (!items.some((item) => item.id === note.id))
				return Err(`${notePath(note)} is no longer listed.`);
			return Ok({ kind: 'result', note });
		}
	}
}

/**
 * Delete what was confirmed, checking a recording's results against
 * `snapshot`, the folder as the lists show it now: one saved since the
 * person was asked keeps it. The files go in order (results, the note, then
 * the audio), and the first that cannot be deleted stops the rest, so no
 * result ever names a recording that is gone. Answers why it stopped, or
 * undefined.
 */
export async function runDeletion(
	writes: {
		/** Delete one note. */
		deleteNote(note: NoteRef): Promise<Result<unknown, { message: string }>>;
		/** Delete recording `id`'s audio. */
		deleteAudio(id: string): Promise<Result<unknown, { message: string }>>;
	},
	snapshot: FolderSnapshot,
	deletion: Deletion,
): Promise<string | undefined> {
	const remove = async (note: NoteRef) =>
		(await writes.deleteNote(note)).error?.message;
	if (deletion.kind !== 'recording') return remove(deletedNote(deletion));
	const { id } = deletion;
	const { data: now, error } = resultsOf(snapshot, id);
	if (error !== null) return error;
	const confirmed = new Set(deletion.results.map(notePath));
	if (now.some((result) => !confirmed.has(notePath(result))))
		return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
	// Results first, so none is ever left naming a recording that is gone.
	for (const result of deletion.results) {
		const problem = await remove(result);
		if (problem !== undefined) return problem;
	}
	const problem = await remove({ collection: 'recordings', id });
	if (problem !== undefined) return problem;
	return (await writes.deleteAudio(id)).error?.message;
}

const count = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** What a person is told before a deletion: what goes and what stays. */
export function describeDeletion(deletion: Deletion): {
	title: string;
	description: string;
} {
	switch (deletion.kind) {
		case 'recording': {
			const removed = [
				...(deletion.noted ? ['its note'] : []),
				...(deletion.audio ? [`its audio (${deletion.audio})`] : []),
				...(deletion.results.length > 0
					? [count(deletion.results.length, 'transcript', 'transcripts')]
					: []),
			];
			return {
				title: `Delete “${deletion.title}”?`,
				description: `This deletes ${removed.join(', ')}.`,
			};
		}
		case 'result':
			return {
				title: 'Delete this transcript?',
				description: `This deletes ${notePath(deletion.note)}.`,
			};
		case 'invalid':
			return {
				title: `Delete ${notePath(deletion.note)}?`,
				description: `It does not read (${deletion.problem}), so this deletes only that file.`,
			};
	}
}
