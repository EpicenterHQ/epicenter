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
 * why one failed, and an answer whose write failed. Such an answer is written
 * again while the page lives; a reload drops it and its row stays unfinished.
 * Waiting for an endpoint is never folder work, so closing does not wait for
 * a request. Writing its answer is: once the folder is closing, an answer
 * that arrives, or a retry that comes due, writes nothing.
 * An answer publishes into the current row body. A row already absent when
 * checked is left absent; admitted publications finish in call order.
 */
import type { Row } from '@epicenter/folder';
import type { FileEdit } from '@epicenter/folder/edits';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type ConnectionsInfo, sameBaseUrl } from './connections.js';
import {
	RECORDINGS,
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
import { describeError, listingOf } from './files.js';
import type { WhisperingFolder } from './folder.js';
import type { WhisperingServices } from './platform/types.js';
import type { RecipeRow, ResolvedRecipe } from './recipe.js';
import { recordingAudio } from './recording-audio.js';

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
	 * The answer arrived and is being written. `message` says why the last
	 * write failed; it is written again while this window is open.
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
/** The first wait before an answer is written again, doubled each time up to the last. */
const RETRY_FIRST_MS = 500;
const RETRY_LAST_MS = 30_000;

const pathOf = (target: Target) => rowPath(target.table, target.stem);

/** Why a row's text does not read, in the words the person is shown. */
const unread = (row: Pick<Row, 'issues'>) =>
	row.issues?.map((issue) => issue.message).join(' ') ?? '';

export function createRuns({
	folder,
	transcribe,
	transform,
	makeId,
	refused,
	connections,
	resolve,
	deleting,
	isCapturing,
	track,
}: {
	transcribe: WhisperingServices['transcribe'];
	transform: WhisperingServices['transform'];
	folder: WhisperingFolder;
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
	/**
	 * Run folder work as a mutation, so a view of `scope` knows it is running;
	 * what it saves reaches the views on the folder's change channel. `scope`
	 * names the recording or file it is for.
	 * Waiting on an endpoint is not tracked.
	 */
	track: <T>(work: () => Promise<T>, scope: string) => Promise<T>;
}) {
	/** Transcribe presses, by recording ID: one under way, or why one sent nothing. */
	const transcriptions = new SvelteMap<string, TranscriptionRun>();
	/** Result rows with something happening in this window, by path. */
	const live = new SvelteMap<
		string,
		{ readonly state: LiveResult; readonly recording: string | undefined }
	>();
	/** Result rows being written now, by path, each naming its recording (none for pasted text). */
	const writing = new Map<string, string | undefined>();
	/** Recipe runs under way, by transcript and recipe pair, or pasted text and recipe. */
	const applying = new SvelteMap<string, RecipeRun>();
	/** Result rows whose run again is reading what it sends. */
	const again = new SvelteSet<string>();
	const retries = new Map<string, ReturnType<typeof setTimeout>>();

	const setLive = (target: Target, state: LiveResult) =>
		live.set(pathOf(target), { state, recording: target.recording });
	const scopeOf = (target: Target) =>
		target.recording === undefined
			? pathOf(target)
			: rowPath('recordings', target.recording);

	/** Run `work` as the folder work of `target`, counted as a write of its row. */
	async function writeOf<T>(
		target: Target,
		work: () => Promise<T>,
	): Promise<T> {
		const path = pathOf(target);
		writing.set(path, target.recording);
		try {
			return await track(work, scopeOf(target));
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
		fields: Record<string, unknown>,
	): Promise<Result<void, string>> {
		setLive(target, { kind: 'running' });
		const begun = await writeOf(
			target,
			async (): Promise<Result<void, string>> => {
				try {
					if (target.recording !== undefined) {
						const { data: recording, error } =
							await folder.tables.recordings.get(target.recording);
						// A recording file that needs repair is still there.
						if (error === null && recording === undefined)
							return Err('The recording is no longer in the folder.');
					}
					const late = refused();
					if (late !== undefined) return Err(late);
					if (target.recording !== undefined && deleting.has(target.recording))
						return Err(BEING_DELETED);
					const { error } = await folder.tables[target.table].set(target.stem, {
						fields,
						body: '',
					});
					return error === null ? Ok(undefined) : Err(describeError(error));
				} catch (cause) {
					// The folder went away.
					return Err(describe(cause));
				}
			},
		);
		if (begun.error !== null) live.delete(pathOf(target));
		return begun;
	}

	/** Capture the acquired source; only an unacquired input needs a read. */
	async function currentContent<Schema extends TSchema>(
		edit: FileEdit<Schema>,
	) {
		const acquired = edit.getSnapshot().content;
		if (acquired !== undefined) return Ok(acquired);
		const { error } = await edit.refresh();
		if (error !== null) return Err(describeError(error));
		const content = edit.getSnapshot().content;
		return content === undefined
			? Err('This file has no editable text.')
			: Ok(content);
	}

	/** Validate held recording facts and discover its current audio sibling. */
	async function audioAt(recording: string): Promise<Result<string, string>> {
		const { data: entry, error } = await currentContent(
			folder.tables.recordings.edit(recording),
		);
		if (error !== null) return Err(error);
		if (entry.issues !== null)
			return Err(
				`The recording needs repair before it is transcribed: ${unread(entry)}`,
			);
		const late = refused();
		if (late !== undefined) return Err(late);
		if (deleting.has(recording)) return Err(BEING_DELETED);
		if (isCapturing(recording)) return Err(STILL_RECORDING);
		const listed = await folder.files.list(RECORDINGS);
		if (listed.error !== null) return Err(describeError(listed.error));
		const audio = recordingAudio(recording, {
			listing: listingOf(listed.data),
			settling: false,
		});
		if (audio.kind === 'ambiguous')
			return Err(
				`More than one audio file matches this recording: ${audio.paths.join(', ')}. Keep one matching file before transcribing.`,
			);
		return audio.kind === 'here' ? Ok(audio.path) : Err(NO_AUDIO);
	}

	/**
	 * Publish the answer into the current row body. A row already absent when
	 * checked is left absent; admitted publications finish in call order.
	 */
	async function fill(target: Target, body: string) {
		try {
			const { data: stored, error } = await folder.tables[target.table].get(
				target.stem,
			);
			if (error !== null) return describeError(error);
			if (stored === undefined || refused() !== undefined) return undefined;
			const { error: writeError } = await folder.tables[target.table].set(
				target.stem,
				{
					body,
				},
			);
			return writeError === null ? undefined : describeError(writeError);
		} catch (cause) {
			return describe(cause);
		}
	}

	/**
	 * Write a received answer into its row. Each attempt checks the app's closing
	 * state before reading or saving. A failed write is retried in the background
	 * until it lands or this window closes.
	 */
	async function write(target: Target, text: string, attempt: number) {
		const path = pathOf(target);
		retries.delete(path);
		const before = live.get(path)?.state;
		setLive(target, {
			kind: 'writing',
			text,
			message: before?.kind === 'writing' ? before.message : undefined,
		});
		if (refused() !== undefined) return;
		const error = await writeOf(target, () => fill(target, resultBody(text)));
		if (error === undefined) {
			live.delete(path);
			return;
		}
		setLive(target, { kind: 'writing', text, message: error });
		if (refused() !== undefined) return;
		const wait = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_LAST_MS);
		retries.set(
			path,
			setTimeout(() => void write(target, text, attempt + 1), wait),
		);
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
		await write(target, answer.data.text, 0);
	}

	/** Capture the recipe exactly as held, including accepted unpublished input. */
	async function recipeAt(
		path: string,
	): Promise<Result<{ stem: string; resolved: ResolvedRecipe }, string>> {
		const stem = rowIdOf(TRANSFORMATIONS, path);
		if (stem === undefined) return Err(`${path} is not a transformation.`);
		const { data: stored, error } = await currentContent(
			folder.tables.transformations.edit(stem),
		);
		if (error !== null) return Err(error);
		return Ok({
			stem,
			resolved: resolve(stored.issues === null ? stored : undefined),
		});
	}

	/**
	 * Capture the held transcript text and validate the recording it names.
	 * The result records this input before its request is sent.
	 */
	async function transcriptAt(
		path: string,
	): Promise<
		Result<
			{ transcriptionId: string; recordingId: string; input: string },
			string
		>
	> {
		const transcriptionId = rowIdOf(TRANSCRIPTIONS, path);
		if (transcriptionId === undefined)
			return Err(`${path} is not a transcript.`);
		const { data: stored, error } = await currentContent(
			folder.tables.transcriptions.edit(transcriptionId),
		);
		if (error !== null) return Err(error);
		if (stored.issues !== null)
			return Err(
				`${path} needs repair before it can be transformed: ${unread(stored)} Fix it from Files.`,
			);
		const input = stored.body;
		const { recordingId } = stored.fields;
		if (input.trim() === '')
			return Err('This transcript has no text to transform.');
		const { data: recording, error: recordingError } =
			await folder.tables.recordings.get(recordingId);
		if (recordingError !== null) return Err(recordingError.message);
		// A recording file that needs repair is still there.
		if (recording === undefined)
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
		prepare: () => Promise<
			| string
			| {
					readonly target: Target;
					readonly fields: TransformationRunFields | TextRunFields;
			  }
		>,
	): Promise<string | undefined> {
		applying.set(key, run);
		try {
			const prepared = await prepare();
			if (typeof prepared === 'string') return prepared;
			const { target, fields } = prepared;
			const { error: problem } = await begin(target, fields);
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
	 * What running a result row again sends, read from the row and the folder
	 * now, or why it is not sent.
	 */
	async function againOf(path: string): Promise<
		Result<
			{
				target: Target;
				request: () => Promise<Answer>;
			},
			string
		>
	> {
		const table = (
			[TRANSCRIPTIONS, TRANSFORMATION_RUNS, TEXT_RUNS] as const
		).find((name) => rowIdOf(name, path) !== undefined);
		if (table === undefined) return Err(`${path} is not a result.`);
		const stem = rowIdOf(table, path) as string;
		const { data: stored, error } = await currentContent(
			folder.tables[table].edit(stem),
		);
		if (error !== null) return Err(error);
		// The result must still have its durable record before sending again.
		const persisted = await folder.tables[table].get(stem);
		if (persisted.error !== null) return Err(describeError(persisted.error));
		if (persisted.data === undefined)
			return Err(`${path} is no longer in the folder.`);
		if (stored.issues !== null)
			return Err(
				`${path} needs repair before it runs again: ${unread(stored)}`,
			);
		if (stored.body !== '')
			return Err('This already has its answer, so nothing was sent.');
		if (table === TRANSCRIPTIONS) {
			const fields = stored.fields as TranscriptionFields;
			const recording = fields.recordingId;
			const moved = connectionMoved('transcription', fields.endpoint);
			if (moved !== undefined) return Err(moved);
			if (deleting.has(recording)) return Err(BEING_DELETED);
			if (isCapturing(recording)) return Err(STILL_RECORDING);
			const { data: audioPath, error: audioError } = await audioAt(recording);
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
		/** Answers that arrived and whose file could not be written yet. */
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
			for (const [path, { state, recording }] of live)
				if (recording === id && state.kind === 'running')
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
			for (const [path, { state, recording }] of live)
				if (recording === id && state.kind === 'failed') live.delete(path);
		},
		/** Cancel the waits before answers are written again; once refused, none is set. */
		stop() {
			for (const timer of retries.values()) clearTimeout(timer);
			retries.clear();
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
				const { data: audioPath, error: audioError } = await audioAt(id);
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
		 * Apply the current held transformation to the current held transcript. Its result is a new row, written before the request goes
		 * out; the transcript is never written. Answers why nothing was sent.
		 */
		async transform(
			transcriptionPath: string,
			transformationPath: string,
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
				async () => {
					const { data: recipe, error } = await recipeAt(transformationPath);
					if (error !== null) return error;
					const { resolved } = recipe;
					if (resolved.kind !== 'ready') return resolved.reason;
					const { data: source, error: sourceError } =
						await transcriptAt(transcriptionPath);
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
		 * Apply the current held recipe to pasted text, taken as it is now. Its result
		 * is a new row in `text_runs/`, written before the request goes out.
		 * Answers why nothing was sent.
		 */
		async transformText(
			transformationPath: string,
			input: string,
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
				async () => {
					const { data: recipe, error } = await recipeAt(transformationPath);
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
				const { data: prepared, error } = await againOf(path);
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
