/**
 * Deleting from the folder: capture what a deletion removes from fresh reads,
 * tell the person exactly that, and delete those files.
 *
 * A file is deleted as it is when the deletion runs: typing held for it is
 * saved first, then the file is read and deleted as read. Each delete names
 * the content it read (ADR-0632), so a file another program changes in that
 * moment is kept, and the person is told.
 *
 * Deleting a recording removes its row, its transcripts, and the results made
 * from them. The audio its row names is an ordinary file the table does not
 * own: it stays, and Files can delete it. It is refused while a request for
 * it runs or a result row of it is being written, and while a result file
 * cannot say which recording it belongs to. A result on pasted text names no
 * recording and is never part of one.
 */
import type { ReadError, Row, SaveError } from '@epicenter/folder';
import { basename } from '@epicenter/folder/file-browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	RECORDINGS,
	type RecordingFields,
	rowIdOf,
	rowPath,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
	type TransformationFields,
} from './definition.js';
import { describeError, listingOf, readBytes } from './files.js';
import type { WhisperingFolder } from './folder.js';
import { recordingAudio } from './recording-audio.js';

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

/** The tables a deletion removes rows from. */
type DeletedTable =
	| typeof RECORDINGS
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATIONS
	| typeof TRANSFORMATION_RUNS;

export type DeletionContext = {
	readonly folder: WhisperingFolder;
	/**
	 * Delete a row as it is stored once the typing held for it saved: the
	 * edit layer's delete. `deleted: false` when it changed meanwhile.
	 */
	deleteRow(
		table: DeletedTable,
		id: string,
	): Promise<
		Result<
			{ deleted: boolean },
			| SaveError
			| ReadError
			| { readonly name: string; readonly message: string }
		>
	>;
	/** Send the typing held for `path`, row or text; answers whether some still did not save. */
	settle(path: string): Promise<boolean>;
	/** Why a recording cannot be deleted now, while work for it is under way. */
	busy(recordingId: string): string | undefined;
	/** The title of the recording that names `path` as its audio, if one does. */
	audioOf(path: string): string | undefined;
};

const UNSAVED =
	'It has typing that did not save. Save or discard it, then delete it.';

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
 * Every result row naming `id`, read now: transcripts, then transformation
 * results. Refused while any result does not read, since it might be this
 * recording's.
 */
async function resultsOf(
	{ folder }: DeletionContext,
	id: string,
): Promise<Result<string[], string>> {
	const [transcripts, outputs] = await Promise.all([
		folder.tables.transcriptions.list(),
		folder.tables.transformation_runs.list(),
	]);
	if (transcripts.error !== null) return Err(transcripts.error.message);
	if (outputs.error !== null) return Err(outputs.error.message);
	const found: string[] = [];
	const unknown: string[] = [];
	for (const [table, rows] of [
		[TRANSCRIPTIONS, transcripts.data],
		[TRANSFORMATION_RUNS, outputs.data],
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
 * Typing held for it is saved first.
 */
export async function captureDeletion(
	context: DeletionContext,
	path: string,
): Promise<Result<Deletion, string>> {
	const { folder } = context;
	const recordingId = rowIdOf(RECORDINGS, path);
	const transformationId = rowIdOf(TRANSFORMATIONS, path);
	if (recordingId !== undefined) {
		const busy = context.busy(recordingId);
		if (busy !== undefined) return Err(busy);
	}
	if (await context.settle(path)) return Err(UNSAVED);

	if (recordingId !== undefined) {
		const { data: stored, error } =
			await folder.tables.recordings.get(recordingId);
		if (error !== null) return Err(error.message);
		if (stored === undefined)
			return Err('This recording is no longer in the folder.');
		if (stored.issues !== null)
			return Ok({
				kind: 'file',
				path,
				recordingId,
				problem: problemOf(stored),
			});
		const fields: RecordingFields = stored.fields;
		const { data: results, error: resultsError } = await resultsOf(
			context,
			recordingId,
		);
		if (resultsError !== null) return Err(resultsError);
		const listed = await folder.files.list(RECORDINGS);
		if (listed.error !== null) return Err(listed.error.message);
		const audio = recordingAudio(recordingId, {
			listing: listingOf(listed.data),
			settling: false,
		});
		return Ok({
			kind: 'recording',
			id: recordingId,
			title: recordingTitle({
				stem: recordingId,
				path,
				row: { fields },
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
		const [stored, outputs, texts] = await Promise.all([
			folder.tables.transformations.get(transformationId),
			folder.tables.transformation_runs.list(),
			folder.tables.text_runs.list(),
		]);
		if (stored.error !== null) return Err(stored.error.message);
		if (stored.data === undefined)
			return Err('This transformation is no longer in the folder.');
		if (stored.data.issues !== null)
			return Ok({ kind: 'file', path, problem: problemOf(stored.data) });
		const fields: TransformationFields = stored.data.fields;
		const results = [...(outputs.data ?? []), ...(texts.data ?? [])].filter(
			(row) =>
				row.issues === null && row.fields.transformationId === transformationId,
		).length;
		return Ok({
			kind: 'transformation',
			title: fields.title.trim() === '' ? basename(path) : fields.title,
			path,
			results,
		});
	}

	const { data: found, error: readError } = await folder.files.read(path);
	if (readError !== null) return Err(readError.message);
	if (found === undefined)
		return Err(`${basename(path)} is no longer in the folder.`);
	return Ok({ kind: 'file', path, audioOf: context.audioOf(path) });
}

/** Why a delete kept what it was asked to delete: it changed while it was deleted. */
const changedMeanwhile = (path: string) =>
	`${path} changed while it was being deleted, so it was kept. Check it, then delete it again.`;

/** Delete the row `id` of `table` as it is stored now. */
async function deleteRow(
	context: RunContext,
	table: DeletedTable,
	id: string,
): Promise<string | undefined> {
	const path = rowPath(table, id);
	const { data, error } = await context.deleteRow(table, id);
	if (error !== null) return describeError(error);
	if (!data.deleted) {
		// Kept because it changed, or already gone, here or elsewhere.
		const { data: still } = await context.folder.tables[table].get(id);
		if (still !== undefined) return changedMeanwhile(path);
	}
	context.deleted(path);
	return undefined;
}

/** Delete the file at `path` as it holds now, row or not. */
async function deleteFile(
	context: RunContext,
	path: string,
): Promise<string | undefined> {
	const { data: bytes, error: readError } = await readBytes(
		context.folder,
		path,
	);
	if (readError !== null) return readError;
	const { data, error } = await context.folder.files.delete(path, bytes);
	if (error !== null) return describeError(error);
	if (!data.deleted) return changedMeanwhile(path);
	context.deleted(path);
	return undefined;
}

type RunContext = DeletionContext & {
	/** Recordings whose deletion is under way. */
	readonly deleting: Set<string>;
	dropFailed(recordingId: string): void;
	/** The caches let a deleted file go. */
	deleted(path: string): void;
};

/**
 * Delete exactly what was confirmed. `deleting` holds the recording while it
 * is deleted, so nothing new starts for it.
 */
export async function runDeletion(
	context: RunContext,
	deletion: Deletion,
): Promise<string | undefined> {
	switch (deletion.kind) {
		case 'transformation': {
			const id = rowIdOf(TRANSFORMATIONS, deletion.path);
			if (id === undefined) return deleteFile(context, deletion.path);
			return deleteRow(context, TRANSFORMATIONS, id);
		}
		case 'file': {
			const id = deletion.recordingId;
			if (id === undefined) return deleteFile(context, deletion.path);
			const busy = context.busy(id);
			if (busy !== undefined) return busy;
			context.deleting.add(id);
			try {
				return await deleteFile(context, deletion.path);
			} finally {
				context.deleting.delete(id);
			}
		}
		case 'recording': {
			const { id } = deletion;
			const busy = context.busy(id);
			if (busy !== undefined) return busy;
			context.deleting.add(id);
			try {
				// Reserve before reading: no request starts while this list is read.
				const { data: now, error } = await resultsOf(context, id);
				if (error !== null) return error;
				const confirmed = new Set(deletion.results);
				if (now.some((result) => !confirmed.has(result)))
					return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
				const refused = await deleteRow(context, RECORDINGS, id);
				if (refused !== undefined) return refused;
				context.dropFailed(id);
				// One file at a time: a refusal keeps that file, and what was
				// deleted before it stays deleted.
				const leftovers: string[] = [];
				for (const result of deletion.results) {
					const transcript = rowIdOf(TRANSCRIPTIONS, result);
					const output = rowIdOf(TRANSFORMATION_RUNS, result);
					const problem =
						transcript !== undefined
							? await deleteRow(context, TRANSCRIPTIONS, transcript)
							: output !== undefined
								? await deleteRow(context, TRANSFORMATION_RUNS, output)
								: await deleteFile(context, result);
					if (problem !== undefined) leftovers.push(result);
				}
				return leftovers.length > 0
					? `The recording was deleted, but these files were not: ${leftovers.join(', ')}`
					: undefined;
			} finally {
				context.deleting.delete(id);
			}
		}
	}
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
			return { title: `Delete ${basename(path)}?`, description: what };
		}
	}
}
