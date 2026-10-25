/**
 * Deleting from the folder: capture what a deletion removes from the mirror,
 * tell the person exactly that, and delete those files.
 *
 * The mirror shows what is on disk, so a capture reads it synchronously and
 * a deletion checks it again before deleting. Each delete removes the file
 * as it is when its save runs.
 *
 * Deleting a recording removes its row, its transcripts, and the results made
 * from them. The audio its row names is an ordinary file the table does not
 * own: it stays, and Files can delete it. It is refused while a request for
 * it runs or a result row of it is being written, and while a result file
 * cannot say which recording it belongs to. A result on pasted text names no
 * recording and is never part of one.
 */
import type { Row } from '@epicenter/folder/next';
import { basename } from '@epicenter/folder/file-browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	RECORDINGS,
	rowIdOf,
	rowPath,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
} from './definition.js';
import { describeError } from './files.js';
import type { WhisperingFolder } from './folder.js';
import type { RecordingAudio } from './recording-audio.js';

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'recording';
			readonly id: string;
			readonly title: string;
			/** The recording's row file. */
			readonly path: string;
			/** The audio the row names. It is not deleted: it stays as an ordinary file. */
			readonly audioPath: string | undefined;
			/** Its transcripts, then the results made from them, by path. */
			readonly results: readonly string[];
	  }
	| {
			readonly kind: 'transformation';
			readonly title: string;
			readonly path: string;
			/** How many saved results name it. They are kept. */
			readonly results: number;
	  }
	| {
			readonly kind: 'file';
			readonly path: string;
			/** Why a recording or transformation file does not read as one; only it goes. */
			readonly problem?: string;
			/** The recording a recording file's name makes it; nothing runs for it meanwhile. */
			readonly recordingId?: string;
			/** The recording that names this file as its audio, by title. */
			readonly audioOf?: string;
	  };

export type DeletionContext = {
	readonly folder: WhisperingFolder;
	/** Why a recording cannot be deleted now, while work for it is under way. */
	busy(recordingId: string): string | undefined;
	/** Where the recording `id`'s audio is. */
	audioOf(id: string): RecordingAudio;
	/** The title of the recording that names `path` as its audio, if one does. */
	namingAudio(path: string): string | undefined;
};

/** A recording's title, or its ID when the title is empty. */
export function recordingTitle(entry: {
	readonly stem: string;
	readonly path: string;
	readonly row: { readonly fields: { readonly title: string } };
}): string {
	const { title } = entry.row.fields;
	if (title.trim() !== '') return title;
	return entry.stem === '' ? entry.path : entry.stem;
}

/** Why a row does not read, in the words the person is shown. */
function problemOf(row: Row): string {
	if (row.issues === null) return '';
	return row.issues.some((issue) => issue.kind === 'not-text')
		? 'it is not text'
		: row.issues.map((issue) => issue.message).join(' ');
}

/**
 * Every result row naming `id`, as the mirror shows them: transcripts, then
 * transformation results. Refused while any result does not read, since it
 * might be this recording's.
 */
function resultsOf(
	folder: WhisperingFolder,
	id: string,
): Result<string[], string> {
	const found: string[] = [];
	const unknown: string[] = [];
	for (const [table, rows] of [
		[TRANSCRIPTIONS, folder.tables.transcriptions.rows],
		[TRANSFORMATION_RUNS, folder.tables.transformation_runs.rows],
	] as const)
		for (const row of rows) {
			const path = rowPath(table, row.id);
			if (row.issues !== null) unknown.push(path);
			else if (row.fields.recordingId === id) found.push(path);
		}
	if (unknown.length > 0)
		return Err(
			`Some results cannot be told apart from this recording’s, because they do not read: ${unknown.join(', ')}. Repair or remove them from Files first, so none is left naming a recording that is gone.`,
		);
	return Ok(found);
}

/**
 * Capture what deleting `path` would remove, for the person to confirm.
 * Capturing changes nothing.
 */
export function captureDeletion(
	context: DeletionContext,
	path: string,
): Result<Deletion, string> {
	const { folder } = context;
	const recordingId = rowIdOf(RECORDINGS, path);
	const transformationId = rowIdOf(TRANSFORMATIONS, path);
	if (recordingId !== undefined) {
		const busy = context.busy(recordingId);
		if (busy !== undefined) return Err(busy);
		const stored = folder.tables.recordings.row(recordingId);
		if (stored === undefined)
			return Err('This recording is no longer in the folder.');
		if (stored.issues !== null)
			return Ok({
				kind: 'file',
				path,
				recordingId,
				problem: problemOf(stored),
			});
		const { data: results, error: resultsError } = resultsOf(
			folder,
			recordingId,
		);
		if (resultsError !== null) return Err(resultsError);
		const audio = context.audioOf(recordingId);
		return Ok({
			kind: 'recording',
			id: recordingId,
			title: recordingTitle({
				stem: recordingId,
				path,
				row: { fields: stored.fields },
			}),
			path,
			audioPath:
				audio.kind === 'here' || audio.kind === 'absent'
					? audio.path
					: undefined,
			results,
		});
	}

	if (transformationId !== undefined) {
		const stored = folder.tables.transformations.row(transformationId);
		if (stored === undefined)
			return Err('This transformation is no longer in the folder.');
		if (stored.issues !== null)
			return Ok({ kind: 'file', path, problem: problemOf(stored) });
		const results = [
			...folder.tables.transformation_runs.rows,
			...folder.tables.text_runs.rows,
		].filter(
			(row) =>
				row.issues === null && row.fields.transformationId === transformationId,
		).length;
		const { title } = stored.fields;
		return Ok({
			kind: 'transformation',
			title: title.trim() === '' ? basename(path) : title,
			path,
			results,
		});
	}

	if (folder.file(path) === undefined)
		return Err(`${basename(path)} is no longer in the folder.`);
	return Ok({ kind: 'file', path, audioOf: context.namingAudio(path) });
}

/** Delete one confirmed path. */
async function deleteFile(
	context: RunContext,
	path: string,
): Promise<string | undefined> {
	const { error } = await context.folder.delete(path);
	if (error !== null) return describeError(error);
	context.deleted(path);
	return undefined;
}

type RunContext = {
	readonly folder: WhisperingFolder;
	dropFailed(recordingId: string): void;
	/** The view state lets a deleted file go. */
	deleted(path: string): void;
};

/**
 * Delete the confirmed paths, checking the recording's results against the
 * mirror again first.
 */
export async function runDeletion(
	context: RunContext,
	deletion: Deletion,
): Promise<string | undefined> {
	if (deletion.kind !== 'recording') return deleteFile(context, deletion.path);
	const { id } = deletion;
	const { data: now, error } = resultsOf(context.folder, id);
	if (error !== null) return error;
	const confirmed = new Set(deletion.results);
	if (now.some((result) => !confirmed.has(result)))
		return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
	const refused = await deleteFile(context, deletion.path);
	if (refused !== undefined) return refused;
	context.dropFailed(id);
	// A partial failure reports the paths left after earlier successful deletions.
	const leftovers: string[] = [];
	for (const result of deletion.results) {
		const problem = await deleteFile(context, result);
		if (problem !== undefined) leftovers.push(result);
	}
	return leftovers.length > 0
		? `The recording was deleted, but these files were not: ${leftovers.join(', ')}`
		: undefined;
}

const count = (n: number, one: string, many: string) =>
	`${n} ${n === 1 ? one : many}`;

/** What a person is told before a deletion: which files go and which stay. */
export function describeDeletion(deletion: Deletion): {
	title: string;
	description: string;
} {
	switch (deletion.kind) {
		case 'recording': {
			const removed = [
				deletion.path,
				...(deletion.results.length > 0
					? [count(deletion.results.length, 'result', 'results')]
					: []),
			];
			// The row is deleted. Its audio is a separate file that no row owns.
			return {
				title: `Delete “${deletion.title}”?`,
				description: `This deletes ${removed.join(', ')} from the folder.${
					deletion.audioPath
						? ` Its audio ${deletion.audioPath} is not deleted: it stays in the folder as an ordinary file, and you can delete it from Files.`
						: ''
				}`,
			};
		}
		case 'transformation':
			return {
				title: `Delete the transformation “${deletion.title}”?`,
				description: `This deletes ${deletion.path} from the folder. ${
					deletion.results > 0
						? `Its ${count(deletion.results, 'saved result stays', 'saved results stay')} in transformation_runs or text_runs, each with the prompt it used.`
						: 'It has no saved results.'
				}`,
			};
		case 'file': {
			const { path } = deletion;
			const what = deletion.problem
				? `${path} does not read as a ${
						deletion.recordingId === undefined ? 'transformation' : 'recording'
					} (${deletion.problem}), so this deletes only that file. ${
						deletion.recordingId === undefined
							? 'Saved results made with it are kept.'
							: 'Transcripts, results, and audio that go with it are kept.'
					}`
				: `This deletes ${path} from the folder.${
						deletion.audioOf
							? ` The recording “${deletion.audioOf}” names it as its audio and is kept, with no audio to play or transcribe.`
							: ''
					}`;
			return {
				title: `Delete ${basename(path)}?`,
				description:
					rowIdOf(TRANSFORMATION_RUNS, path) !== undefined
						? `${what} The transcript it was made from is not changed.`
						: what,
			};
		}
	}
}
