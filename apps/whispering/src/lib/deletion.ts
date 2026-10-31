/**
 * Deleting: capture what a deletion removes from what the lists show, tell
 * the person exactly that, and delete those files.
 *
 * Deleting a recording removes its note, its audio, its transcripts, and the
 * results made from them, wherever each is: on this device, or in the
 * repository (online only). It is refused while a request for it runs or a
 * result of it is being kept, and while a result does not read, since it
 * might be this recording's. A result on pasted text names no recording and
 * is never part of one. Deleting a transformation keeps the results it made,
 * each of which carries the prompt it used.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type {
	NoteName,
	RecordingAudio,
	WhisperingFiles,
} from './files.svelte.js';

/** One note a deletion removes: its collection and id. */
export type NoteRef = {
	readonly collection: NoteName;
	readonly id: string;
};

/** A note's file, `<collection>/<id>.md`. */
export const notePath = ({ collection, id }: NoteRef) =>
	`${collection}/${id}.md`;

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'recording';
			readonly id: string;
			readonly title: string;
			/** Its audio file, when one is listed. */
			readonly audio: string | undefined;
			/** Its transcripts, then the results made from them. */
			readonly results: readonly NoteRef[];
	  }
	| {
			readonly kind: 'transformation';
			readonly id: string;
			readonly title: string;
			/** How many saved results name it. They are kept. */
			readonly results: number;
	  }
	| {
			/** One result: a transcript, or a transformation's result. */
			readonly kind: 'result';
			readonly note: NoteRef;
	  }
	| {
			/** A note that does not read; only it goes. */
			readonly kind: 'invalid';
			readonly note: NoteRef;
			readonly problem: string;
	  };

export type DeletionContext = {
	readonly files: WhisperingFiles;
	/** Why a recording cannot be deleted now, while work for it is under way. */
	busy(recordingId: string): string | undefined;
};

/** A title, or the id when the title is empty. */
export function titleOf(note: { readonly id: string; readonly title: string }) {
	return note.title.trim() === '' ? note.id : note.title;
}

/** Why a note does not read, in a line. */
export const describeIssues = (
	issues: readonly { field: string; message: string }[],
) =>
	issues
		.map(({ field, message }) => (field ? `${field}: ${message}` : message))
		.join('; ');

/** Where a recording's audio file is, as the person is told it. */
function audioPath(id: string, audio: RecordingAudio) {
	return audio.kind === 'here'
		? `recordings/${id}.${audio.file.ext}`
		: audio.kind === 'ambiguous'
			? audio.exts.map((ext) => `recordings/${id}.${ext}`).join(', ')
			: undefined;
}

/**
 * Every result naming recording `id`: transcripts, then transformation
 * results. Refused while any result does not read, since it might be this
 * recording's.
 */
function resultsOf(
	files: WhisperingFiles,
	id: string,
): Result<NoteRef[], string> {
	const unknown = [
		...files.transcriptions.invalid,
		...files.transformation_runs.invalid,
	].map((note) => note.path);
	if (unknown.length > 0)
		return Err(
			`Some results cannot be told apart from this recording’s, because they do not read: ${unknown.join(', ')}. Repair or delete them first, so none is left naming a recording that is gone.`,
		);
	return Ok([
		...files.transcriptions.items
			.filter((note) => note.recordingId === id)
			.map((note) => ({ collection: 'transcriptions' as const, id: note.id })),
		...files.transformation_runs.items
			.filter((note) => note.recordingId === id)
			.map((note) => ({
				collection: 'transformation_runs' as const,
				id: note.id,
			})),
	]);
}

/**
 * Capture what deleting `note` would remove, for the person to confirm.
 * Capturing changes nothing.
 */
export function captureDeletion(
	{ files, busy }: DeletionContext,
	note: NoteRef,
): Result<Deletion, string> {
	const invalid = files[note.collection].invalid.find(
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
			const recording = files.recordings.get({ id: note.id });
			if (recording === undefined)
				return Err('This recording is no longer listed.');
			const { data: results, error } = resultsOf(files, note.id);
			if (error !== null) return Err(error);
			return Ok({
				kind: 'recording',
				id: note.id,
				title: titleOf(recording),
				audio: audioPath(note.id, files.audioOf(note.id)),
				results,
			});
		}
		case 'transformations': {
			const recipe = files.transformations.get({ id: note.id });
			if (recipe === undefined)
				return Err('This transformation is no longer listed.');
			const results = [
				...files.transformation_runs.items,
				...files.text_runs.items,
			].filter((run) => run.transformationId === note.id).length;
			return Ok({
				kind: 'transformation',
				id: note.id,
				title: titleOf(recipe),
				results,
			});
		}
		default: {
			if (files[note.collection].get({ id: note.id }) === undefined)
				return Err(`${notePath(note)} is no longer listed.`);
			return Ok({ kind: 'result', note });
		}
	}
}

type RunContext = {
	readonly files: WhisperingFiles;
	/** Forget what failed for a recording that is gone. */
	dropFailed(recordingId: string): void;
	/** The view state lets a deleted note go. */
	deleted(note: NoteRef): void;
};

async function deleteNote(
	{ files, deleted }: RunContext,
	note: NoteRef,
): Promise<string | undefined> {
	const { error } = await files[note.collection].delete({ id: note.id });
	if (error !== null && error.name !== 'NotFound') return error.message;
	deleted(note);
	return undefined;
}

/**
 * Delete what was confirmed, checking a recording's results against the
 * lists again first: one saved since the person was asked keeps it.
 */
export async function runDeletion(
	context: RunContext,
	deletion: Deletion,
): Promise<string | undefined> {
	if (deletion.kind === 'transformation')
		return deleteNote(context, {
			collection: 'transformations',
			id: deletion.id,
		});
	if (deletion.kind !== 'recording') return deleteNote(context, deletion.note);
	const { id } = deletion;
	const { data: now, error } = resultsOf(context.files, id);
	if (error !== null) return error;
	const confirmed = new Set(deletion.results.map(notePath));
	if (now.some((result) => !confirmed.has(notePath(result))))
		return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
	// Results first, so none is ever left naming a recording that is gone.
	const leftovers: string[] = [];
	for (const result of deletion.results) {
		const problem = await deleteNote(context, result);
		if (problem !== undefined)
			leftovers.push(`${notePath(result)}: ${problem}`);
	}
	if (leftovers.length > 0)
		return `The recording was kept, because some of its results could not be deleted: ${leftovers.join(', ')}.`;
	const refused = await deleteNote(context, { collection: 'recordings', id });
	if (refused !== undefined) return refused;
	context.dropFailed(id);
	const audio = await context.files.deleteAudio(id);
	return audio.error === null
		? undefined
		: `The recording was deleted, but its audio was not: ${audio.error}`;
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
				'its note',
				...(deletion.audio ? [`its audio (${deletion.audio})`] : []),
				...(deletion.results.length > 0
					? [count(deletion.results.length, 'result', 'results')]
					: []),
			];
			return {
				title: `Delete “${deletion.title}”?`,
				description: `This deletes ${removed.join(', ')}.`,
			};
		}
		case 'transformation':
			return {
				title: `Delete the transformation “${deletion.title}”?`,
				description: `This deletes transformations/${deletion.id}.md. ${
					deletion.results > 0
						? `Its ${count(deletion.results, 'saved result stays', 'saved results stay')}, each with the prompt it used.`
						: 'It has no saved results.'
				}`,
			};
		case 'result':
			return {
				title:
					deletion.note.collection === 'transcriptions'
						? 'Delete this transcript?'
						: 'Delete this result?',
				description: `This deletes ${notePath(deletion.note)}.${
					deletion.note.collection === 'transformation_runs'
						? ' The transcript it was made from is not changed.'
						: deletion.note.collection === 'transcriptions'
							? ' Results made from it are kept.'
							: ''
				}`,
			};
		case 'invalid':
			return {
				title: `Delete ${notePath(deletion.note)}?`,
				description: `It does not read (${deletion.problem}), so this deletes only that file.`,
			};
	}
}
