/**
 * Requests to an endpoint and the result rows they fill: transcriptions of a
 * recording, and recipe runs on a transcript or on pasted text (ADR-0542).
 *
 * A run writes its result row before its request goes out, with every field
 * fixed and an empty body, and fills the body when the answer arrives. So the
 * folder holds every run from its start. A row with no body and no request in
 * this window is unfinished: that is derived here and never written. Running
 * it again sends the same request from the row's own fields into the same
 * row; deleting it discards it.
 *
 * What lives only in this window is what is happening: a request under way,
 * why one failed, and an answer whose file could not be written. That answer
 * stays here, with why, until the person saves it again or copies it; nothing
 * sends its request again. A reload loses it, and its row stays unfinished.
 * Waiting for an endpoint is never folder work, so closing does not wait for
 * a request. Once the folder is closing, an answer that arrives writes
 * nothing.
 *
 * A run sends what the person sees: the recipe and transcript text a view
 * shows, typing included, or else the rows in the folder. An answer sets the
 * row's body as it is when the save runs; a row deleted meanwhile is left
 * absent.
 */
import type { Row } from '@epicenter/folder/next';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type ConnectionsInfo, sameBaseUrl } from './connections.js';
import {
	rowIdOf,
	rowPath,
	TEXT_RUNS,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationRunFields,
} from './definition.js';
import { describeError, type PresentWriteFailure, WRITE_FAILED } from './files.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import type { RecipeRow, ResolvedRecipe } from './recipe.js';
import type { RecordingAudio } from './recording-audio.js';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * A received answer as its row's body: the text, ending in one newline of its
 * own. An empty answer is a newline, so only a row nothing was written to has
 * an empty body.
 */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** A sortable id from a time: `20260102-030405-k3f9`. */
export type MakeId = (at: Date) => string;

/** A Transcribe of a recording under way, or why the last one sent nothing. */
export type TranscriptionRun =
	| { readonly kind: 'running' }
	| { readonly kind: 'failed'; readonly message: string };

/** What this window knows about a result row with no body. */
export type LiveResult =
	/** The request is out. */
	| { readonly kind: 'running' }
	/** Nothing was received. Running it again sends the same request. */
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The answer arrived and is being written, or `message` says why it was
	 * not. A failed answer is written again only when the person asks.
	 */
	| {
			readonly kind: 'writing';
			readonly text: string;
			readonly message: string | undefined;
	  };

/** What a result row shows: its answer, what is happening to it, or that it is unfinished. */
export type ResultState =
	| { readonly kind: 'answered' }
	| LiveResult
	| { readonly kind: 'unfinished' };

/** What a view shows of a run's inputs, typing included; each one left out is read from its row. */
export type RunInputs = {
	readonly recipe?: RecipeRow;
	/** The transcript text. */
	readonly input?: string;
};

/** A recipe run under way in this window, from its reads to its answer. */
export type RecipeRun = {
	readonly transformationId: string;
	/** The transcript it runs on; undefined for pasted text. */
	readonly transcriptionId: string | undefined;
};

type ResultTable =
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATION_RUNS
	| typeof TEXT_RUNS;

/** One result row: where it is, and the recording it belongs to, if any. */
type Target = {
	readonly table: ResultTable;
	readonly stem: string;
	readonly recording: string | undefined;
};

type Answer = Result<{ text: string }, { message: string }>;

const ANSWERED: ResultState = { kind: 'answered' };
const UNFINISHED: ResultState = { kind: 'unfinished' };
const BEING_DELETED = 'This recording is being deleted.';
const STILL_RECORDING =
	'This recording is still recording. Stop it, then transcribe it.';
const NO_AUDIO =
	'This recording’s audio is not on this device. Put one supported audio file beside its Markdown file with the same stem.';
const pathOf = (target: Target) => rowPath(target.table, target.stem);
const RESULT_TABLES = [TRANSCRIPTIONS, TRANSFORMATION_RUNS, TEXT_RUNS] as const;
/** The result table `path` is a row of, and its stem. */
function resultAt(
	path: string,
): { table: ResultTable; stem: string } | undefined {
	for (const table of RESULT_TABLES) {
		const stem = rowIdOf(table, path);
		if (stem !== undefined) return { table, stem };
	}
	return undefined;
}

/** Why a row's text does not read, in the words the person is shown. */
const unread = (row: Pick<Row, 'issues'>) =>
	row.issues?.map((issue) => issue.message).join(' ') ?? '';

export function createRuns({
	folder,
	presentWriteFailure,
	transcribe,
	transform,
	makeId,
	refused,
	connections,
	resolve,
	deleting,
	isCapturing,
	audioOf,
}: {
	transcribe: WhisperingServices['transcribe'];
	transform: WhisperingServices['transform'];
	folder: WhisperingFolder;
	presentWriteFailure: PresentWriteFailure;
	makeId: MakeId;
	/** Why nothing new starts now, if it does not. */
	refused: () => string | undefined;
	connections: () => {
		readonly info: ConnectionsInfo | undefined;
		readonly error: string | undefined;
	};
	resolve: (recipe: RecipeRow | undefined) => ResolvedRecipe;
	/** Recordings whose deletion is under way. No request starts for one. */
	deleting: ReadonlySet<string>;
	/** The recording still being captured. Its audio is not finished, so it is not transcribed. */
	isCapturing: (id: string) => boolean;
	audioOf: (id: string) => RecordingAudio;
}) {
	/** Transcribe presses, by recording ID: one under way, or why one sent nothing. */
	const transcriptions = new SvelteMap<string, TranscriptionRun>();
	/** Result rows with something happening in this window, by path. */
	const live = new SvelteMap<
		string,
		{ readonly state: LiveResult; readonly target: Target }
	>();
	/** Result rows being written now, by path, each naming its recording (none for pasted text). */
	const writing = new Map<string, string | undefined>();
	/** Recipe runs under way, by transcript and recipe pair, or pasted text and recipe. */
	const applying = new SvelteMap<string, RecipeRun>();
	/** Result rows whose run again is reading what it sends. */
	const again = new SvelteSet<string>();

	const setLive = (target: Target, state: LiveResult) =>
		live.set(pathOf(target), { state, target });

	/** Run `work` as the folder work of `target`, counted as a write of its row. */
	async function writeOf<T>(
		target: Target,
		work: () => Promise<T>,
	): Promise<T> {
		const path = pathOf(target);
		writing.set(path, target.recording);
		try {
			return await work();
		} finally {
			writing.delete(path);
		}
	}

	/**
	 * Write a run's row with an empty body, before its request goes out. The
	 * row shows as running from the moment it is listed. A recording deleted
	 * meanwhile gets no row. Answers the row it wrote, to fill, or why it
	 * wrote none.
	 */
	async function begin(
		target: Target,
		fields: TranscriptionFields | TransformationRunFields | TextRunFields,
	): Promise<Result<void, string>> {
		setLive(target, { kind: 'running' });
		const begun = await writeOf(
			target,
			async (): Promise<Result<void, string>> => {
				try {
					if (
						target.recording !== undefined &&
						folder.tables.recordings.row(target.recording) === undefined
					)
						return Err('The recording is no longer in the folder.');
					const late = refused();
					if (late !== undefined) return Err(late);
					if (target.recording !== undefined && deleting.has(target.recording))
						return Err(BEING_DELETED);
					const { error } = await createRow(target, fields);
					if (error === null) return Ok(undefined);
					presentWriteFailure('Nothing was sent: the result file could not be written', error);
					return Err(WRITE_FAILED);
				} catch (cause) {
					// The folder went away.
					return Err(describe(cause));
				}
			},
		);
		if (begun.error !== null) live.delete(pathOf(target));
		return begun;
	}

	/** A result row of `target`'s table, with an empty body. */
	function createRow(
		target: Target,
		fields: TranscriptionFields | TransformationRunFields | TextRunFields,
	) {
		switch (target.table) {
			case TRANSCRIPTIONS:
				return folder.tables.transcriptions.create(target.stem, {
					// SAFETY: transcript targets are created with transcription fields.
					fields: fields as TranscriptionFields,
					body: '',
				});
			case TRANSFORMATION_RUNS:
				return folder.tables.transformation_runs.create(target.stem, {
					// SAFETY: transformation result targets carry transformation result fields.
					fields: fields as TransformationRunFields,
					body: '',
				});
			case TEXT_RUNS:
				return folder.tables.text_runs.create(target.stem, {
					// SAFETY: text result targets carry text result fields.
					fields: fields as TextRunFields,
					body: '',
				});
		}
	}

	/** The recording's audio sibling, from its row and the listing the mirror shows. */
	function audioAt(recording: string): Result<string, string> {
		const entry = folder.tables.recordings.row(recording);
		if (entry === undefined)
			return Err('The recording is no longer in the folder.');
		if (entry.issues !== null)
			return Err(
				`The recording needs repair before it is transcribed: ${unread(entry)}`,
			);
		const late = refused();
		if (late !== undefined) return Err(late);
		if (deleting.has(recording)) return Err(BEING_DELETED);
		if (isCapturing(recording)) return Err(STILL_RECORDING);
		const audio = audioOf(recording);
		if (audio.kind === 'ambiguous')
			return Err(
				`More than one audio file matches this recording: ${audio.paths.join(', ')}. Keep one matching file before transcribing.`,
			);
		return audio.kind === 'here' ? Ok(audio.path) : Err(NO_AUDIO);
	}

	/** Set the answer as the row's body, leaving a row deleted meanwhile absent. */
	async function fill(target: Target, body: string) {
		try {
			if (refused() !== undefined) return undefined;
			const { error } = await folder.tables[target.table].update(target.stem, {
				body,
			});
			return error === null || error.name === 'NothingToUpdate'
				? undefined
				: describeError(error);
		} catch (cause) {
			return describe(cause);
		}
	}

	/**
	 * Write a received answer once. A failure stays in this window for an
	 * explicit Save again, without another provider request.
	 */
	async function write(target: Target, text: string) {
		const path = pathOf(target);
		setLive(target, { kind: 'writing', text, message: undefined });
		if (refused() !== undefined) return;
		const error = await writeOf(target, () => fill(target, resultBody(text)));
		if (error === undefined) {
			live.delete(path);
			return;
		}
		setLive(target, { kind: 'writing', text, message: error });
	}

	/**
	 * Send the request for a row already in the folder, then write its answer
	 * into its current body. Ends when the answer's first publication ends.
	 */
	async function send(target: Target, request: () => Promise<Answer>) {
		const why =
			refused() ??
			(target.recording !== undefined && deleting.has(target.recording)
				? BEING_DELETED
				: undefined);
		if (why !== undefined) {
			setLive(target, { kind: 'failed', message: why });
			return;
		}
		setLive(target, { kind: 'running' });
		let answer: Answer;
		try {
			answer = await request();
		} catch (cause) {
			answer = Err({
				message: `The request could not be made: ${describe(cause)}`,
			});
		}
		if (answer.error !== null) {
			setLive(target, { kind: 'failed', message: answer.error.message });
			return;
		}
		await write(target, answer.data.text);
	}

	/** The recipe to send: the one shown, or else its row in the folder. */
	function recipeAt(
		path: string,
		shown: RecipeRow | undefined,
	): Result<{ stem: string; resolved: ResolvedRecipe }, string> {
		const stem = rowIdOf(TRANSFORMATIONS, path);
		if (stem === undefined) return Err(`${path} is not a transformation.`);
		if (shown !== undefined) return Ok({ stem, resolved: resolve(shown) });
		const row = folder.tables.transformations.row(stem);
		if (row === undefined) return Err(`${path} is no longer in the folder.`);
		return Ok({
			stem,
			resolved: resolve(row.issues === null ? row : undefined),
		});
	}

	/**
	 * The transcript text to send, as shown or else its row's body, and the
	 * recording its row names. The result records this input before its
	 * request is sent.
	 */
	function transcriptAt(
		path: string,
		shown: string | undefined,
	): Result<
		{ transcriptionId: string; recordingId: string; input: string },
		string
	> {
		const transcriptionId = rowIdOf(TRANSCRIPTIONS, path);
		if (transcriptionId === undefined)
			return Err(`${path} is not a transcript.`);
		const row = folder.tables.transcriptions.row(transcriptionId);
		if (row === undefined) return Err(`${path} is no longer in the folder.`);
		if (row.issues !== null)
			return Err(
				`${path} needs repair before it can be transformed: ${unread(row)} Fix it from Files.`,
			);
		const input = shown ?? row.body;
		const { recordingId } = row.fields;
		if (input.trim() === '')
			return Err('This transcript has no text to transform.');
		// A recording file that needs repair is still there.
		if (folder.tables.recordings.row(recordingId) === undefined)
			return Err(
				'The recording this transcript was made from is no longer in the folder.',
			);
		if (deleting.has(recordingId)) return Err(BEING_DELETED);
		return Ok({ transcriptionId, recordingId, input });
	}

	/** Why a row made with `endpoint` would not go out over the connection set up now. */
	function connectionMoved(
		operation: 'transcription' | 'text',
		endpoint: string,
	): string | undefined {
		const connection = connections().info?.[operation];
		if (connection === undefined)
			return `This was run with ${endpoint}, and no ${operation} connection is set up now, so it was not sent again.`;
		if (!sameBaseUrl(connection.baseUrl, endpoint))
			return `This was run with ${endpoint}, and the ${operation} connection is now ${connection.baseUrl}, so it was not sent again. Delete it and run it anew.`;
		return undefined;
	}

	/**
	 * Run a recipe whose row `prepare` makes from what it reads now. `key`
	 * names the pair, so the same pair does not run twice at once.
	 */
	async function runRecipe(
		key: string,
		run: RecipeRun,
		prepare: () =>
			| string
			| {
					readonly target: Target;
					readonly fields: TransformationRunFields | TextRunFields;
			  },
	): Promise<string | undefined> {
		applying.set(key, run);
		try {
			const prepared = prepare();
			if (typeof prepared === 'string') return prepared;
			const { target, fields } = prepared;
			const { error: problem } = await begin(target, fields);
			if (problem === WRITE_FAILED) return WRITE_FAILED;
			if (problem !== null)
				return `Nothing was sent: the result’s file could not be written. ${problem}`;
			await send(target, () =>
				transform({
					expectedBaseUrl: fields.endpoint,
					model: fields.model,
					prompt: fields.prompt,
					input: fields.input,
				}),
			);
			return undefined;
		} finally {
			applying.delete(key);
		}
	}

	/**
	 * What running a result row again sends, read from its row in the folder
	 * now, or why it is not sent.
	 */
	function againOf(path: string): Result<
		{
			target: Target;
			request: () => Promise<Answer>;
		},
		string
	> {
		const at = resultAt(path);
		if (at === undefined) return Err(`${path} is not a result.`);
		const { table, stem } = at;
		const stored = folder.tables[table].row(stem);
		if (stored === undefined) return Err(`${path} is no longer in the folder.`);
		if (stored.issues !== null)
			return Err(
				`${path} needs repair before it runs again: ${unread(stored)}`,
			);
		if (stored.body !== '')
			return Err('This already has its answer, so nothing was sent.');
		if (table === TRANSCRIPTIONS) {
			// SAFETY: a transcriptions row that reads has transcription fields.
			const fields = stored.fields as TranscriptionFields;
			const recording = fields.recordingId;
			const moved = connectionMoved('transcription', fields.endpoint);
			if (moved !== undefined) return Err(moved);
			if (deleting.has(recording)) return Err(BEING_DELETED);
			if (isCapturing(recording)) return Err(STILL_RECORDING);
			const { data: audioPath, error: audioError } = audioAt(recording);
			if (audioError !== null) return Err(audioError);
			return Ok({
				target: { table, stem, recording },
				request: () =>
					transcribe({
						audioPath,
						expectedBaseUrl: fields.endpoint,
						model: fields.model,
					}),
			});
		}
		// SAFETY: a recipe result row that reads has recipe result fields.
		const fields = stored.fields as TransformationRunFields | TextRunFields;
		const moved = connectionMoved('text', fields.endpoint);
		if (moved !== undefined) return Err(moved);
		const recording = 'recordingId' in fields ? fields.recordingId : undefined;
		if (recording !== undefined && deleting.has(recording))
			return Err(BEING_DELETED);
		return Ok({
			target: { table, stem, recording },
			request: () =>
				transform({
					expectedBaseUrl: fields.endpoint,
					model: fields.model,
					prompt: fields.prompt,
					input: fields.input,
				}),
		});
	}

	return {
		/** A Transcribe of this recording under way, or why the last one sent nothing. */
		transcriptionRun(id: string) {
			return transcriptions.get(id);
		},
		/** Drop why a Transcribe sent nothing. */
		dismissRun(id: string) {
			if (transcriptions.get(id)?.kind === 'failed') transcriptions.delete(id);
		},
		/** What the result row at `path`, with `body`, shows now. */
		resultState(path: string, body: string): ResultState {
			if (body !== '') return ANSWERED;
			return live.get(path)?.state ?? UNFINISHED;
		},
		/** Recipe runs under way in this window. */
		get recipeRuns(): RecipeRun[] {
			return [...applying.values()];
		},
		/** Answers that arrived and whose file could not be written. */
		get unwritten(): number {
			return [...live.values()].filter(
				({ state }) => state.kind === 'writing' && state.message !== undefined,
			).length;
		},
		/**
		 * Why a recording cannot be deleted now: a request for it is out, or a
		 * row of it is being written. Either would leave a result naming a
		 * recording that is gone.
		 */
		busy(id: string): string | undefined {
			const transcribing =
				'A transcription of this recording is still running. Wait for it to finish, then delete the recording.';
			if (transcriptions.get(id)?.kind === 'running') return transcribing;
			for (const [path, { state, target }] of live)
				if (target.recording === id && state.kind === 'running')
					return rowIdOf(TRANSCRIPTIONS, path) !== undefined
						? transcribing
						: 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
			if ([...writing.values()].includes(id))
				return 'A result for this recording is still being written to the folder. Wait for it to finish, then delete the recording.';
			return undefined;
		},
		/** Forget what failed for a deleted recording: its rows are gone. */
		dropFailed(id: string) {
			if (transcriptions.get(id)?.kind === 'failed') transcriptions.delete(id);
			for (const [path, { state, target }] of live)
				if (target.recording === id && state.kind === 'failed')
					live.delete(path);
		},
		/** Forget window-only state once its result file was deleted. */
		forget(path: string) {
			live.delete(path);
		},
		/**
		 * Write an answer whose file could not be written, once more. Nothing
		 * is sent to the endpoint.
		 */
		async saveAgain(path: string): Promise<void> {
			const current = live.get(path);
			if (
				current?.state.kind !== 'writing' ||
				current.state.message === undefined
			)
				return;
			await write(current.target, current.state.text);
		},

		/**
		 * Transcribe a recording: write a transcript row naming it, send the
		 * audio its row names over the transcription connection, then write the
		 * answer into that row.
		 */
		async transcribe(entry: { readonly stem: string }) {
			if (refused() !== undefined) return;
			const id = entry.stem;
			if (transcriptions.get(id)?.kind === 'running' || deleting.has(id))
				return;
			const fail = (message: string) => {
				transcriptions.set(id, { kind: 'failed', message });
			};
			if (isCapturing(id)) return fail(STILL_RECORDING);
			const { info, error: connectionsError } = connections();
			const connection = info?.transcription;
			if (connection === undefined)
				return fail(
					connectionsError === undefined
						? 'No transcription connection is set up, so nothing was sent. Set one up in Settings, then transcribe.'
						: `The transcription connection could not be read, so nothing was sent: ${connectionsError}`,
				);
			const running: TranscriptionRun = { kind: 'running' };
			transcriptions.set(id, running);
			try {
				const { data: audioPath, error: audioError } = audioAt(id);
				if (audioError !== null) return fail(audioError);
				const at = new Date();
				const target: Target = {
					table: TRANSCRIPTIONS,
					stem: makeId(at),
					recording: id,
				};
				const fields: TranscriptionFields = {
					recordingId: id,
					createdAt: at.toISOString() as TranscriptionFields['createdAt'],
					model: connection.model,
					endpoint: connection.baseUrl,
				};
				const { error: problem } = await begin(target, fields);
				if (problem === WRITE_FAILED)
					return fail('Nothing was sent. Try again.');
				if (problem !== null)
					return fail(
						`Nothing was sent: the transcript’s file could not be written. ${problem}`,
					);
				await send(target, () =>
					transcribe({
						audioPath,
						expectedBaseUrl: connection.baseUrl,
						model: connection.model,
					}),
				);
			} finally {
				if (transcriptions.get(id) === running) transcriptions.delete(id);
			}
		},

		/**
		 * Apply a recipe to a transcript, each as `shown` or else as its row in
		 * the folder. Its result is a new row, written before the request goes
		 * out; the transcript is never written. Answers why nothing was sent.
		 */
		async transform(
			transcriptionPath: string,
			transformationPath: string,
			shown: RunInputs = {},
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const key = JSON.stringify([transcriptionPath, transformationPath]);
			if (applying.has(key))
				return 'This transformation is already running on this transcript. Run it again when it has finished.';
			return runRecipe(
				key,
				{
					transformationId:
						rowIdOf(TRANSFORMATIONS, transformationPath) ?? transformationPath,
					transcriptionId: rowIdOf(TRANSCRIPTIONS, transcriptionPath),
				},
				() => {
					const { data: recipe, error } = recipeAt(
						transformationPath,
						shown.recipe,
					);
					if (error !== null) return error;
					const { resolved } = recipe;
					if (resolved.kind !== 'ready') return resolved.reason;
					const { data: source, error: sourceError } = transcriptAt(
						transcriptionPath,
						shown.input,
					);
					if (sourceError !== null) return sourceError;
					const late = refused();
					if (late !== undefined) return late;
					const at = new Date();
					return {
						target: {
							table: TRANSFORMATION_RUNS,
							stem: makeId(at),
							recording: source.recordingId,
						},
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
					};
				},
			);
		},
		/**
		 * Apply a recipe, as `shown` or else as its row in the folder, to
		 * pasted text taken as it is now. Its result is a new row in
		 * `text_runs/`, written before the request goes out. Answers why
		 * nothing was sent.
		 */
		async transformText(
			transformationPath: string,
			input: string,
			shown: Pick<RunInputs, 'recipe'> = {},
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			if (input.trim() === '') return 'Paste some text to run this on.';
			const stem = rowIdOf(TRANSFORMATIONS, transformationPath);
			if (stem === undefined)
				return `${transformationPath} is not a transformation.`;
			const key = JSON.stringify(['text', transformationPath]);
			if (applying.has(key))
				return 'This transformation is already running on pasted text. Run it again when it has finished.';
			return runRecipe(
				key,
				{ transformationId: stem, transcriptionId: undefined },
				() => {
					const { data: recipe, error } = recipeAt(
						transformationPath,
						shown.recipe,
					);
					if (error !== null) return error;
					const { resolved } = recipe;
					if (resolved.kind !== 'ready') return resolved.reason;
					const late = refused();
					if (late !== undefined) return late;
					const at = new Date();
					return {
						target: {
							table: TEXT_RUNS,
							stem: makeId(at),
							recording: undefined,
						},
						fields: {
							transformationId: stem,
							transformationTitle: resolved.title,
							createdAt: at.toISOString(),
							model: resolved.model,
							endpoint: resolved.endpoint,
							prompt: resolved.prompt,
							input,
						} as TextRunFields,
					};
				},
			);
		},
		/**
		 * Send the request of an unfinished result row again, from the row's own
		 * fields, and write the answer into the same row. Sent only while the
		 * connection is still the one the row names. Answers why nothing was
		 * sent.
		 */
		async runAgain(path: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const state = live.get(path)?.state;
			if (again.has(path) || (state !== undefined && state.kind !== 'failed'))
				return 'This is already running.';
			again.add(path);
			try {
				const { data: prepared, error } = againOf(path);
				if (error !== null) return error;
				const late = refused();
				if (late !== undefined) return late;
				await send(prepared.target, prepared.request);
				return undefined;
			} finally {
				again.delete(path);
			}
		},
	};
}

export type Runs = ReturnType<typeof createRuns>;
