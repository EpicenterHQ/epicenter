/**
 * Requests to an endpoint and the result rows they write: transcriptions of a
 * recording, and recipe runs on a transcript or on pasted text.
 *
 * A result's stem and every field it will hold are fixed before its row is
 * written, so every save of one answer lands in the same file. Each save is
 * one `createOnce`: create the row, and when the stem is taken, read what is
 * there; the same row means an earlier save landed (its reply was lost), and
 * anything else is another file, left as it is. Saving again never calls the
 * endpoint.
 *
 * A received answer whose row is not known to be in the folder stays in this
 * window, with its text, until it is saved or discarded. A save that ends
 * after its run was discarded, or replaced by a newer one, restores nothing
 * and removes nothing; a row it wrote stays.
 */
import {
	type FileTable,
	type Row,
	rowPath,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type ConnectionsInfo, sameBaseUrl } from './connections.js';
import {
	audioPathIn,
	RECORDINGS,
	type RecordingFields,
	TEXT_RUNS,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
	type TransformationRunFields,
} from './definition.js';
import { describeError } from './files.js';
import type { ResolvedRecipe } from './recipe.js';
import type { Workspace } from './workspace/types.js';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** A received answer as its row's body: the text, ending in one newline of its own. */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** Deep equality of parsed values, ignoring the order of an object's keys. */
function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => sameValue(item, b[index]))
		);
	if (
		typeof a !== 'object' ||
		typeof b !== 'object' ||
		a === null ||
		b === null
	)
		return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
		)
	);
}

/**
 * Whether a saved row is `row`: the same body and the same fields, keys
 * another writer added included.
 */
function sameRow<TFields>(saved: Row<TFields>, row: Row<TFields>): boolean {
	return saved.body === row.body && sameValue(saved.fields, row.fields);
}

/**
 * Create `row` at `stem`, once. A stem already taken by this exact row is an
 * earlier save of it that landed; any other file there is left alone.
 */
export async function createOnce<TFields>(
	table: FileTable<TFields>,
	stem: string,
	row: Row<TFields>,
	what: string,
): Promise<Result<StoredRow<TFields>, string>> {
	try {
		const { data: created, error } = await table.create(row, { stem });
		if (error === null) return Ok(created);
		if (error.name !== 'Exists') return Err(describeError(error));
		const { data: there, error: readError } = await table.get(stem);
		if (readError === null && there !== undefined && sameRow(there.row, row))
			return Ok(there);
		if (readError !== null && readError.name !== 'InvalidRow')
			return Err(readError.message);
		return Err(
			`${rowPath(table.name, stem)} already exists and is not this ${what}. Nothing was overwritten.`,
		);
	} catch (cause) {
		// The folder host went away: the answer is kept, not lost with it.
		return Err(describe(cause));
	}
}

/** A sortable id from a time: `20260102-030405-k3f9`. */
export type MakeId = (at: Date) => string;

/** One transcription request for a recording, until its result row is saved. */
export type TranscriptionRun =
	/** The request is out, or its answer is being written for the first time. */
	| { readonly kind: 'running' }
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The endpoint answered, and the result row is not known to be in the
	 * folder. `saving` is true while a save of it is under way.
	 */
	| {
			readonly kind: 'unsaved';
			/** The result row's stem. */
			readonly id: string;
			readonly row: Row<TranscriptionFields>;
			/** The answer as received: what is shown and copied. */
			readonly text: string;
			readonly message: string;
			readonly saving: boolean;
	  };

/** Where a recipe run stands, until its result row is saved. */
export type RunState =
	| { readonly kind: 'running' }
	/** Nothing was received. Trying again sends the same request. */
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The endpoint answered and the text is held here. `message` says why a
	 * save did not finish; undefined for a result on pasted text not yet saved.
	 */
	| {
			readonly kind: 'unsaved';
			readonly message: string | undefined;
			readonly text: string;
	  };

/**
 * A recipe applied to a transcript. A received result is saved at once, into
 * `transformation_runs/`. `id` and `fields` are fixed before the request.
 */
export type TransformationRun = {
	readonly id: string;
	readonly destination: 'transcript';
	readonly fields: TransformationRunFields;
	readonly state: RunState;
};

/** A recipe applied to pasted text; its result waits for Save, into `text_runs/`. */
export type TextRun = {
	readonly id: string;
	readonly destination: 'text';
	readonly fields: TextRunFields;
	readonly state: RunState;
};

type Run = TransformationRun | TextRun;

const withState = <TRun extends Run>(run: TRun, state: RunState): TRun => ({
	...run,
	state,
});

const BEING_DELETED = 'This recording is being deleted.';

export function createRuns({
	workspace,
	makeId,
	refused,
	connections,
	resolve,
	settle,
	deleting,
	track,
}: {
	workspace: Workspace;
	makeId: MakeId;
	/** Why nothing new starts now, if it does not. */
	refused: () => string | undefined;
	connections: () => {
		readonly info: ConnectionsInfo | undefined;
		readonly error: string | undefined;
	};
	resolve: (recipe: Row<TransformationFields> | undefined) => ResolvedRecipe;
	/** Resolves once the edits being written have landed, so what is read is what was typed. */
	settle: () => Promise<void>;
	/** Recordings whose deletion is under way. No request starts for one. */
	deleting: ReadonlySet<string>;
	/**
	 * Run folder work as a mutation, so leaving and closing wait for it and
	 * the folder is read again after it. `scope` names the file whose queue
	 * it joins: a recording's results are saved in order, after its writes.
	 * Waiting on an endpoint is not tracked: a request that does not answer
	 * must not keep the app from asking to close.
	 */
	track: <T>(work: () => Promise<T>, scope?: string) => Promise<T>;
}) {
	const { folder } = workspace;
	/** Transcription runs, by recording ID. */
	const transcriptions = new SvelteMap<string, TranscriptionRun>();
	/** Recipe runs, by result stem. */
	const recipes = new SvelteMap<string, Run>();
	/** Result rows being written now, by stem, each naming its recording (none for pasted text). */
	const writing = new Map<string, string | undefined>();
	/** Transcript and recipe pairs, and recipes on pasted text, whose reads are under way. */
	const applying = new SvelteSet<string>();
	const retrying = new SvelteSet<string>();

	const transcriptRuns = () =>
		[...recipes.values()].filter(
			(run): run is TransformationRun => run.destination === 'transcript',
		);
	const textRuns = () =>
		[...recipes.values()].filter(
			(run): run is TextRun => run.destination === 'text',
		);
	const unsaved = {
		transcripts: () =>
			[...transcriptions.values()].filter((run) => run.kind === 'unsaved')
				.length,
		transformations: () =>
			transcriptRuns().filter((run) => run.state.kind === 'unsaved').length,
		text: () => textRuns().filter((run) => run.state.kind === 'unsaved').length,
	};

	/** Save a received transcript. Applied only while `admitted` still stands. */
	async function saveTranscript(
		recording: string,
		received: { id: string; row: Row<TranscriptionFields>; text: string },
		admitted: TranscriptionRun,
	) {
		writing.set(received.id, recording);
		const { error } = await track(
			() =>
				createOnce(
					folder.tables.transcriptions,
					received.id,
					received.row,
					'transcript',
				),
			rowPath(RECORDINGS, recording),
		);
		writing.delete(received.id);
		const stands = transcriptions.get(recording) === admitted;
		if (error !== null) {
			if (stands)
				transcriptions.set(recording, {
					kind: 'unsaved',
					...received,
					message: error,
					saving: false,
				});
			return;
		}
		if (stands) transcriptions.delete(recording);
	}

	/** Save a received recipe result. Applied only while `admitted` still stands. */
	async function saveRun(run: Run, text: string, admitted: Run) {
		const body = resultBody(text);
		writing.set(
			run.id,
			run.destination === 'transcript' ? run.fields.recordingId : undefined,
		);
		const { error } =
			run.destination === 'transcript'
				? await track(
						() =>
							createOnce(
								folder.tables.transformation_runs,
								run.id,
								{ fields: run.fields, body },
								'result',
							),
						rowPath(RECORDINGS, run.fields.recordingId),
					)
				: await track(
						() =>
							createOnce(
								folder.tables.text_runs,
								run.id,
								{ fields: run.fields, body },
								'result',
							),
						rowPath(TEXT_RUNS, run.id),
					);
		writing.delete(run.id);
		const stands = recipes.get(run.id) === admitted;
		if (error !== null) {
			if (stands)
				recipes.set(
					run.id,
					withState(run, { kind: 'unsaved', message: error, text }),
				);
			return;
		}
		if (stands) recipes.delete(run.id);
	}

	/**
	 * One request from a run's fixed fields. It always ends: failed, or
	 * received. A transcript's result is saved at once; one on pasted text
	 * waits for Save.
	 */
	async function sendRun(run: Run) {
		const running = withState(run, { kind: 'running' });
		recipes.set(run.id, running);
		const failed = (message: string) => {
			if (recipes.get(run.id) === running)
				recipes.set(run.id, withState(run, { kind: 'failed', message }));
		};
		let answered: Awaited<ReturnType<Workspace['transform']>>;
		try {
			answered = await workspace.transform({
				expectedBaseUrl: run.fields.endpoint,
				model: run.fields.model,
				prompt: run.fields.prompt,
				input: run.fields.input,
			});
		} catch (cause) {
			failed(
				`The transformation request could not be made: ${describe(cause)}`,
			);
			return;
		}
		const { data: answer, error } = answered;
		if (error !== null) {
			failed(error.message);
			return;
		}
		if (run.destination === 'transcript') {
			await saveRun(run, answer.text, running);
			return;
		}
		if (recipes.get(run.id) === running)
			recipes.set(
				run.id,
				withState(run, {
					kind: 'unsaved',
					message: undefined,
					text: answer.text,
				}),
			);
	}

	/** The saved transformation at `path`, read now, after the edits being written land. */
	async function recipeAt(
		path: string,
	): Promise<Result<{ stem: string; resolved: ResolvedRecipe }, string>> {
		const stem = rowStemOf(TRANSFORMATIONS, path);
		if (stem === undefined) return Err(`${path} is not a transformation.`);
		await settle();
		const { data: stored, error } =
			await folder.tables.transformations.get(stem);
		if (error !== null && error.name !== 'InvalidRow')
			return Err(error.message);
		if (error === null && stored === undefined)
			return Err('This transformation is no longer in the folder.');
		return Ok({ stem, resolved: resolve(stored?.row) });
	}

	/**
	 * What a transformation is made from, read now: the transcript's saved text
	 * and the recording it names. The edits being written land first, so what
	 * is sent is what the folder has.
	 */
	async function transcriptAt(
		path: string,
	): Promise<
		Result<
			{ transcriptionId: string; recordingId: string; input: string },
			string
		>
	> {
		const transcriptionId = rowStemOf(TRANSCRIPTIONS, path);
		if (transcriptionId === undefined)
			return Err(`${path} is not a transcript.`);
		await settle();
		const { data: stored, error } =
			await folder.tables.transcriptions.get(transcriptionId);
		if (error?.name === 'InvalidRow')
			return Err(
				`${path} needs repair before it can be transformed. Fix it from Files.`,
			);
		if (error !== null) return Err(error.message);
		if (stored === undefined)
			return Err('This transcript is no longer in the folder.');
		const input = stored.row.body;
		const { recordingId } = stored.row.fields;
		if (input.trim() === '')
			return Err('This transcript has no text to transform.');
		const { data: recording, error: recordingError } =
			await folder.tables.recordings.get(recordingId);
		// A recording file that needs repair is still there.
		if (recordingError !== null && recordingError.name !== 'InvalidRow')
			return Err(recordingError.message);
		if (recordingError === null && recording === undefined)
			return Err(
				'The recording this transcript was made from is no longer in the folder.',
			);
		if (deleting.has(recordingId)) return Err(BEING_DELETED);
		return Ok({ transcriptionId, recordingId, input });
	}

	/** Why a run prepared for `endpoint` would not go out over the text connection now. */
	function connectionMoved(endpoint: string): string | undefined {
		const text = connections().info?.text;
		if (text === undefined)
			return `This run was prepared for ${endpoint}, and no text connection is set up now, so it was not sent again.`;
		if (!sameBaseUrl(text.baseUrl, endpoint))
			return `This run was prepared for ${endpoint}, and the text connection is now ${text.baseUrl}, so it was not sent again. Dismiss it and run the transformation again.`;
		return undefined;
	}

	/**
	 * Finish a recipe run that did not end as a saved result: save a received
	 * one, or send a failed one again from its fixed fields, only while the
	 * text connection is still the one it was prepared for and, on a
	 * transcript, while the folder still has what it was made from.
	 */
	async function retryRun(id: string) {
		if (refused() !== undefined || retrying.has(id)) return;
		retrying.add(id);
		try {
			const run = recipes.get(id);
			if (run === undefined) return;
			if (run.state.kind === 'unsaved') {
				const { text } = run.state;
				await saveRun(run, text, run);
				return;
			}
			if (run.state.kind !== 'failed') return;
			const stands = () => recipes.get(id) === run;
			const refuse = (message: string) => {
				if (stands())
					recipes.set(id, withState(run, { kind: 'failed', message }));
			};
			const moved = connectionMoved(run.fields.endpoint);
			if (moved !== undefined) return refuse(moved);
			if (run.destination === 'transcript') {
				const { data: source, error } = await track(() =>
					transcriptAt(rowPath(TRANSCRIPTIONS, run.fields.transcriptionId)),
				);
				if (error !== null) return refuse(`${error} Dismiss this run.`);
				if (
					source.input !== run.fields.input ||
					source.recordingId !== run.fields.recordingId
				)
					return refuse(
						'The transcript changed after this run started, so the same request was not sent again. Dismiss this run and run the transformation again.',
					);
			}
			// A discard, a deletion, or a close while the reads ran: nothing is sent.
			if (!stands() || refused() !== undefined) return;
			if (
				run.destination === 'transcript' &&
				deleting.has(run.fields.recordingId)
			)
				return refuse(BEING_DELETED);
			await sendRun(run);
		} finally {
			retrying.delete(id);
		}
	}

	return {
		transcriptionRun(id: string) {
			return transcriptions.get(id);
		},
		get transformationRuns(): TransformationRun[] {
			return transcriptRuns();
		},
		get textRuns(): TextRun[] {
			return textRuns();
		},
		/** Recordings waiting on a transcript whose file is not saved. */
		get unsavedTranscripts(): string[] {
			return [...transcriptions]
				.filter(([, run]) => run.kind === 'unsaved')
				.map(([id]) => id);
		},
		get unsavedResults() {
			return unsaved.transcripts();
		},
		get unsavedTransformations() {
			return unsaved.transformations();
		},
		get unsavedTextResults() {
			return unsaved.text();
		},
		isRetrying(id: string) {
			return retrying.has(id);
		},
		/** What leaving now would lose, one plain line each. */
		held(): string[] {
			const lines: string[] = [];
			const count = (n: number, one: string, many: string) => {
				if (n > 0) lines.push(n === 1 ? one : many.replace('#', String(n)));
			};
			count(
				unsaved.transcripts(),
				'1 transcript arrived but its file is not saved.',
				'# transcripts arrived but their files are not saved.',
			);
			if ([...transcriptions.values()].some((run) => run.kind === 'running'))
				lines.push(
					'A transcription is still running; its result would be lost.',
				);
			count(
				unsaved.transformations(),
				'1 transformation result arrived but its file is not saved.',
				'# transformation results arrived but their files are not saved.',
			);
			count(
				unsaved.text(),
				'1 result on pasted text arrived and is not saved.',
				'# results on pasted text arrived and are not saved.',
			);
			if (
				applying.size > 0 ||
				retrying.size > 0 ||
				[...recipes.values()].some((run) => run.state.kind === 'running')
			)
				lines.push(
					'A transformation is still running; its result would be lost.',
				);
			return lines;
		},
		/**
		 * Why a recording cannot be deleted now: a request for it still runs, an
		 * answer for it is not saved, or a result row for it is being written.
		 * Each would leave a result naming a recording that is gone.
		 */
		busy(id: string): string | undefined {
			const transcript = transcriptions.get(id);
			if (transcript?.kind === 'running')
				return 'A transcription of this recording is still running. Wait for it to finish, then delete the recording.';
			if (transcript?.kind === 'unsaved')
				return 'A transcript of this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
			const own = transcriptRuns().filter(
				(run) => run.fields.recordingId === id,
			);
			if (own.some((run) => run.state.kind === 'running'))
				return 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
			if (own.some((run) => run.state.kind === 'unsaved'))
				return 'A transformation result for this recording arrived but its file is not saved. Save it again or discard it in the notice under the header, then delete the recording.';
			if ([...writing.values()].includes(id))
				return 'A result for this recording is still being written to the folder. Wait for it to finish, then delete the recording.';
			return undefined;
		},
		/** Drop what failed for a deleted recording: it held nothing. */
		dropFailed(id: string) {
			if (transcriptions.get(id)?.kind === 'failed') transcriptions.delete(id);
			for (const run of transcriptRuns())
				if (run.fields.recordingId === id && run.state.kind === 'failed')
					recipes.delete(run.id);
		},

		/**
		 * Transcribe a recording: send the audio its row names over the
		 * transcription connection, then save the answer as a new row.
		 */
		async transcribe(entry: {
			readonly stem: string;
			readonly row: Row<RecordingFields>;
		}) {
			if (refused() !== undefined) return;
			const id = entry.stem;
			const current = transcriptions.get(id)?.kind;
			// A received transcript is held until it is saved or discarded.
			if (current === 'running' || current === 'unsaved') return;
			if (deleting.has(id)) return;
			const audioPath = audioPathIn(entry.row.fields);
			if (audioPath === undefined) {
				transcriptions.set(id, {
					kind: 'failed',
					message:
						'This recording’s file names no audio, so there is nothing to transcribe. Add the audio file’s path in Source.',
				});
				return;
			}
			const { info, error: connectionsError } = connections();
			const connection = info?.transcription;
			if (connection === undefined) {
				transcriptions.set(id, {
					kind: 'failed',
					message:
						connectionsError === undefined
							? 'No transcription connection is set up, so nothing was sent. Set one up in Settings, then transcribe.'
							: `The transcription connection could not be read, so nothing was sent: ${connectionsError}`,
				});
				return;
			}
			const running: TranscriptionRun = { kind: 'running' };
			transcriptions.set(id, running);
			let answered: Awaited<ReturnType<Workspace['transcribe']>>;
			try {
				answered = await workspace.transcribe({
					audioPath,
					expectedBaseUrl: connection.baseUrl,
					model: connection.model,
				});
			} catch (cause) {
				transcriptions.set(id, {
					kind: 'failed',
					message: `The transcription request could not be made: ${describe(cause)}`,
				});
				return;
			}
			const { data: answer, error } = answered;
			if (error !== null) {
				transcriptions.set(id, { kind: 'failed', message: error.message });
				return;
			}
			const at = new Date();
			await saveTranscript(
				id,
				{
					id: makeId(at),
					row: {
						fields: {
							recordingId: id,
							createdAt: at.toISOString(),
							model: connection.model,
							endpoint: connection.baseUrl,
						} as TranscriptionFields,
						body: resultBody(answer.text),
					},
					text: answer.text,
				},
				running,
			);
		},
		/** Save a held transcript again. The endpoint is not called. */
		async retrySaveResult(id: string) {
			if (refused() !== undefined) return;
			const run = transcriptions.get(id);
			if (run?.kind !== 'unsaved' || run.saving) return;
			const admitted: TranscriptionRun = { ...run, saving: true };
			transcriptions.set(id, admitted);
			await saveTranscript(id, run, admitted);
		},
		/** Drop a transcription run that is not running. A write already begun may still land. */
		dismissRun(id: string) {
			if (transcriptions.get(id)?.kind !== 'running') transcriptions.delete(id);
		},

		/**
		 * Apply a saved transformation to a saved transcript, each read from the
		 * folder now. The answer becomes a new row; the transcript is never
		 * written. Answers why nothing was sent.
		 */
		async transform(
			transcriptionPath: string,
			transformationPath: string,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const pair = JSON.stringify([transcriptionPath, transformationPath]);
			const sending = transcriptRuns().some(
				(run) =>
					run.state.kind === 'running' &&
					run.fields.transcriptionId ===
						rowStemOf(TRANSCRIPTIONS, transcriptionPath) &&
					run.fields.transformationId ===
						rowStemOf(TRANSFORMATIONS, transformationPath),
			);
			if (applying.has(pair) || sending)
				return 'This transformation is already running on this transcript. Run it again when it has finished.';
			applying.add(pair);
			// The reads are folder work that leaving waits for; the request is not.
			const prepared = await track(async (): Promise<Run | string> => {
				try {
					const { data: recipe, error } = await recipeAt(transformationPath);
					if (error !== null) return error;
					const { resolved } = recipe;
					if (resolved.kind !== 'ready') return resolved.reason;
					const { data: source, error: sourceError } =
						await transcriptAt(transcriptionPath);
					if (sourceError !== null) return sourceError;
					if (deleting.has(source.recordingId)) return BEING_DELETED;
					const late = refused();
					if (late !== undefined) return late;
					const at = new Date();
					return {
						id: makeId(at),
						destination: 'transcript',
						fields: {
							recordingId: source.recordingId,
							transcriptionId: source.transcriptionId,
							transformationId: recipe.stem,
							transformationTitle: resolved.title,
							createdAt: at.toISOString(),
							model: resolved.model,
							endpoint: resolved.endpoint,
							prompt: resolved.prompt,
							input: source.input,
						} as TransformationRunFields,
						state: { kind: 'running' },
					};
				} finally {
					applying.delete(pair);
				}
			});
			if (typeof prepared === 'string') return prepared;
			await sendRun(prepared);
			return undefined;
		},
		/**
		 * Apply a saved recipe to pasted text, taken as it is now. The answer
		 * is held until `saveTextRun` or a discard. One recipe holds one result
		 * on pasted text at a time.
		 */
		async transformText(
			transformationPath: string,
			input: string,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			if (input.trim() === '') return 'Paste some text to run this on.';
			const stem = rowStemOf(TRANSFORMATIONS, transformationPath);
			if (stem === undefined)
				return `${transformationPath} is not a transformation.`;
			const key = JSON.stringify(['text', transformationPath]);
			const held = textRuns().find(
				(run) =>
					run.fields.transformationId === stem && run.state.kind !== 'failed',
			);
			if (applying.has(key) || held?.state.kind === 'running')
				return 'This transformation is already running on pasted text. Run it again when it has finished.';
			if (held !== undefined)
				return 'A result of this transformation on pasted text is waiting. Save or discard it first, so it is not replaced.';
			applying.add(key);
			// The read is folder work that leaving waits for; the request is not.
			const prepared = await track(async (): Promise<Run | string> => {
				try {
					const { data: recipe, error } = await recipeAt(transformationPath);
					if (error !== null) return error;
					const { resolved } = recipe;
					if (resolved.kind !== 'ready') return resolved.reason;
					const late = refused();
					if (late !== undefined) return late;
					// A failed run held nothing; the new one takes its place.
					for (const run of textRuns())
						if (
							run.fields.transformationId === stem &&
							run.state.kind === 'failed'
						)
							recipes.delete(run.id);
					const at = new Date();
					return {
						id: makeId(at),
						destination: 'text',
						fields: {
							transformationId: stem,
							transformationTitle: resolved.title,
							createdAt: at.toISOString(),
							model: resolved.model,
							endpoint: resolved.endpoint,
							prompt: resolved.prompt,
							input,
						} as TextRunFields,
						state: { kind: 'running' },
					};
				} finally {
					applying.delete(key);
				}
			});
			if (typeof prepared === 'string') return prepared;
			await sendRun(prepared);
			return undefined;
		},
		/** Save a received result on pasted text under the id fixed when it began. */
		async saveTextRun(id: string) {
			const run = recipes.get(id);
			if (run?.destination !== 'text' || run.state.kind !== 'unsaved') return;
			await retryRun(id);
		},
		retryTransformation: retryRun,
		/** Drop a recipe run that is not running. A write already begun may still land. */
		discardTransformationRun(id: string) {
			if (recipes.get(id)?.state.kind !== 'running') recipes.delete(id);
		},
	};
}

export type Runs = ReturnType<typeof createRuns>;
