/**
 * Deleting from the folder: capture what a deletion removes from fresh reads,
 * tell the person exactly that, and delete those files.
 *
 * A file is deleted whatever it holds when the deletion runs, a row or not:
 * a delete beats edits that never saw it (ADR-0576). Edits being written land
 * first, and a deletion runs after the file's queued writes, so what this
 * window saved last goes with it. The person is told when a file has changes
 * that are in no saved version.
 *
 * Deleting a recording removes its row, its transcripts, and the results made
 * from them. The audio its row names is an ordinary file the table does not
 * own: it stays, and Files can delete it. It is refused while a request for
 * it runs or a result row of it is being written, and while a result file
 * cannot say which recording it belongs to. A result on pasted text names no
 * recording and is never part of one.
 */
import {
	type FileListing,
	type FileTable,
	rowPath,
	rowStemOf,
} from '@epicenter/folder';
import { basename } from '@epicenter/folder/file-browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	audioPathIn,
	RECORDINGS,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
} from './definition.js';
import { describeError } from './files.js';
import type { WhisperingFolder } from './workspace/types.js';

/** What a confirmed deletion removes, captured when the person was asked. */
export type Deletion =
	| {
			readonly kind: 'recording';
			readonly id: string;
			readonly title: string;
			/** The recording's row file. */
			readonly path: string;
			/** Whether its files have changes in no saved version; undefined when the check failed. */
			readonly unversioned: boolean | undefined;
			/** The audio the row names. It is not deleted: it stays as an ordinary file. */
			readonly audioPath: string | undefined;
			/** Its transcripts, then the results made from them, by path. */
			readonly results: readonly string[];
	  }
	| {
			readonly kind: 'transformation';
			readonly title: string;
			readonly path: string;
			readonly unversioned: boolean | undefined;
			/** How many saved results name it. They are kept. */
			readonly results: number;
	  }
	| {
			readonly kind: 'file';
			readonly path: string;
			readonly unversioned: boolean | undefined;
			/** Why a recording or transformation file does not read as one; only it goes. */
			readonly problem?: string;
			/** The recording a recording file's name makes it; nothing runs for it meanwhile. */
			readonly recordingId?: string;
			/** The recording that names this file as its audio, by title. */
			readonly audioOf?: string;
	  }
	| { readonly kind: 'folder'; readonly path: string };

export type DeletionContext = {
	readonly folder: WhisperingFolder;
	readonly listing: FileListing | undefined;
	/** Resolves once the edits being written have landed. */
	writesSettled(): Promise<void>;
	/** Why a recording cannot be deleted now, while work for it is under way. */
	busy(recordingId: string): string | undefined;
	/** The title of the recording that names `path` as its audio, if one does. */
	audioOf(path: string): string | undefined;
};

/** A recording's title, or its ID when the title is empty. */
export function recordingTitle(entry: {
	readonly stem: string;
	readonly path: string;
	readonly row: { readonly fields: { readonly title: string } };
}): string {
	const { title } = entry.row.fields;
	if (title.trim() !== '') return title;
	// An empty ID (`recordings/.md`) is a real address but not a readable label.
	return entry.stem === '' ? entry.path : entry.stem;
}

/**
 * Whether any of `paths` has changes in no saved version, by a status check
 * now; undefined when the check failed.
 */
async function unversionedOf(
	{ folder }: DeletionContext,
	paths: readonly string[],
): Promise<boolean | undefined> {
	const { data: status, error } = await folder.git.status();
	if (error !== null) return undefined;
	return status.changes.some((change) => paths.includes(change.path));
}

/** Whether a file is at `path` now, by a fresh read; why not, if not. */
async function presentNow(
	{ folder }: DeletionContext,
	path: string,
): Promise<string | undefined> {
	const { error: readError } = await folder.files.read(path);
	if (readError === null) return undefined;
	return readError.name === 'NotFound'
		? `${basename(path)} is no longer in the folder.`
		: readError.message;
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
	for (const [table, listed] of [
		[TRANSCRIPTIONS, transcripts.data],
		[TRANSFORMATION_RUNS, outputs.data],
	] as const)
		for (const { stem, result } of listed) {
			if (result.error !== null) unknown.push(rowPath(table, stem));
			else if (result.data.row.fields.recordingId === id)
				found.push(result.data.path);
		}
	if (unknown.length > 0)
		return Err(
			`Some results cannot be told apart from this recording’s, because they do not read: ${unknown.join(', ')}. Repair or remove them from Files first, so none is left naming a recording that is gone.`,
		);
	return Ok(found);
}

/**
 * Capture what deleting `path` would remove, for the person to confirm. The
 * edits being written land first. Only empty folders can be deleted.
 */
export async function captureDeletion(
	context: DeletionContext,
	path: string,
): Promise<Result<Deletion, string>> {
	const { folder, listing } = context;
	if (listing?.directories.includes(path)) {
		const prefix = `${path}/`;
		const occupied =
			listing.files.some((file) => file.path.startsWith(prefix)) ||
			listing.directories.some((directory) => directory.startsWith(prefix));
		if (occupied)
			return Err(
				'Only empty folders can be deleted here. Delete or move what is inside first.',
			);
		return Ok({ kind: 'folder', path });
	}
	const recordingId = rowStemOf(RECORDINGS, path);
	const transformationId = rowStemOf(TRANSFORMATIONS, path);
	if (recordingId !== undefined) {
		const busy = context.busy(recordingId);
		if (busy !== undefined) return Err(busy);
	}
	await context.writesSettled();

	if (recordingId !== undefined) {
		const { data: stored, error: readError } =
			await folder.tables.recordings.get(recordingId);
		if (readError?.name === 'InvalidRow' || readError?.name === 'InvalidUtf8')
			return Ok({
				kind: 'file',
				path,
				unversioned: await unversionedOf(context, [path]),
				recordingId,
				problem:
					readError.name === 'InvalidRow'
						? readError.issues.map((issue) => issue.message).join(' ')
						: 'it is not text',
			});
		if (readError !== null) return Err(readError.message);
		if (stored === undefined)
			return Err('This recording is no longer in the folder.');
		const { data: results, error: resultsError } = await resultsOf(
			context,
			recordingId,
		);
		if (resultsError !== null) return Err(resultsError);
		return Ok({
			kind: 'recording',
			id: recordingId,
			title: recordingTitle({ ...stored, stem: recordingId }),
			path: stored.path,
			unversioned: await unversionedOf(context, [stored.path, ...results]),
			audioPath: audioPathIn(stored.row.fields),
			results,
		});
	}

	if (transformationId !== undefined) {
		const [stored, outputs, texts] = await Promise.all([
			folder.tables.transformations.get(transformationId),
			folder.tables.transformation_runs.list(),
			folder.tables.text_runs.list(),
		]);
		if (
			stored.error?.name === 'InvalidRow' ||
			stored.error?.name === 'InvalidUtf8'
		)
			return Ok({
				kind: 'file',
				path,
				unversioned: await unversionedOf(context, [path]),
				problem:
					stored.error.name === 'InvalidRow'
						? stored.error.issues.map((issue) => issue.message).join(' ')
						: 'it is not text',
			});
		if (stored.error !== null) return Err(stored.error.message);
		if (stored.data === undefined)
			return Err('This transformation is no longer in the folder.');
		const results = [...(outputs.data ?? []), ...(texts.data ?? [])].filter(
			({ result }) =>
				result.data?.row.fields.transformationId === transformationId,
		).length;
		const { title } = stored.data.row.fields;
		return Ok({
			kind: 'transformation',
			title: title.trim() === '' ? basename(path) : title,
			path: stored.data.path,
			unversioned: await unversionedOf(context, [path]),
			results,
		});
	}

	const gone = await presentNow(context, path);
	if (gone !== undefined) return Err(gone);
	return Ok({
		kind: 'file',
		path,
		unversioned: await unversionedOf(context, [path]),
		audioOf: context.audioOf(path),
	});
}

/**
 * Delete the file at `path`, whatever it holds now, through its table when
 * it is a row: a delete beats edits that never saw it (ADR-0576).
 */
async function deleteOne(
	context: RunContext,
	path: string,
	table?: Pick<FileTable<unknown>, 'name' | 'delete'>,
): Promise<string | undefined> {
	const stem = table && rowStemOf(table.name, path);
	const { error } =
		table !== undefined && stem !== undefined
			? await table.delete(stem)
			: await context.folder.write(path, null, null);
	if (error !== null) return describeError(error);
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
	const { folder } = context;
	switch (deletion.kind) {
		case 'folder': {
			const { error } = await folder.files.rmdir(deletion.path);
			return error === null ? undefined : describeError(error);
		}
		case 'transformation':
			return deleteOne(
				context,
				deletion.path,
				folder.tables.transformations as FileTable<unknown>,
			);
		case 'file': {
			const id = deletion.recordingId;
			if (id === undefined) return deleteOne(context, deletion.path);
			const busy = context.busy(id);
			if (busy !== undefined) return busy;
			context.deleting.add(id);
			try {
				return await deleteOne(context, deletion.path);
			} finally {
				context.deleting.delete(id);
			}
		}
		case 'recording': {
			const { id } = deletion;
			const busy = context.busy(id);
			if (busy !== undefined) return busy;
			// A result saved since the person was asked was not confirmed.
			const { data: now, error } = await resultsOf(context, id);
			if (error !== null) return error;
			const confirmed = new Set(deletion.results);
			if (now.some((result) => !confirmed.has(result)))
				return 'A new result was saved for this recording after you were asked. Check it, then delete the recording again.';
			context.deleting.add(id);
			try {
				const refused = await deleteOne(
					context,
					deletion.path,
					folder.tables.recordings as FileTable<unknown>,
				);
				if (refused !== undefined) return refused;
				context.dropFailed(id);
				// One file at a time: a refusal keeps that file, and what was
				// deleted before it stays deleted.
				const leftovers: string[] = [];
				for (const result of deletion.results) {
					const problem = await deleteOne(
						context,
						result,
						(rowStemOf(TRANSCRIPTIONS, result) !== undefined
							? folder.tables.transcriptions
							: folder.tables.transformation_runs) as FileTable<unknown>,
					);
					if (problem !== undefined) leftovers.push(result);
				}
				return leftovers.length > 0
					? `The recording was deleted, but these files could not be: ${leftovers.join(', ')}`
					: undefined;
			} finally {
				context.deleting.delete(id);
			}
		}
	}
}

/** What the person is told about history, by whether the files have changes in no saved version. */
function historyNote(unversioned: boolean | undefined): string {
	return unversioned
		? 'It has changes that are in no saved version, and those are lost. Earlier saved versions stay in Git history.'
		: 'Saved versions stay in Git history.';
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
				description: `This deletes ${removed.join(', ')} from the folder. ${
					deletion.audioPath
						? `Its audio ${deletion.audioPath} is not deleted: it stays in the folder as an ordinary file, and you can delete it from Files. `
						: ''
				}${historyNote(deletion.unversioned)}`,
			};
		}
		case 'transformation':
			return {
				title: `Delete the transformation “${deletion.title}”?`,
				description: `This deletes ${deletion.path} from the folder. ${
					deletion.results > 0
						? `Its ${count(deletion.results, 'saved result stays', 'saved results stay')} in transformation_runs or text_runs, each with the prompt it used.`
						: 'It has no saved results.'
				} ${historyNote(deletion.unversioned)}`,
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
				description: `${what} ${historyNote(deletion.unversioned)}`,
			};
		}
		case 'folder':
			return {
				title: `Delete the folder ${basename(deletion.path)}?`,
				description: `${deletion.path} is empty. Deleting it removes only the folder.`,
			};
	}
}
