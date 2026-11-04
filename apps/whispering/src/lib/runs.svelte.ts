/**
 * Requests to an endpoint and the results they make: transcriptions of a
 * recording, and recipe runs on a transcript or on pasted text.
 *
 * A request lives in this window until its answer arrives. Then its result
 * is created as a new note in Whispering's files, every field fixed and the
 * answer as its body. So a result note always holds an answer.
 *
 * What lives only in this window is what is happening: a request under way,
 * why one failed (Run again sends the same request), and an answer whose
 * note could not be created (Save again creates it, without another
 * request). A reload loses them. Waiting for an endpoint never delays
 * closing; an answer that arrives after closing keeps nothing.
 *
 * A run sends what the person sees: the recipe and transcript text a page
 * shows, typing included, or else the notes as listed. Where it goes is
 * fixed when it starts (its target: the endpoint and model chosen then), and
 * Run again sends to that target or, when it was removed or moved, nothing.
 */
import { timeId } from '@epicenter/definition/ids';
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { WhisperingFiles } from './files.svelte.js';
import type { Audio, Target } from './inference.js';
import type { Chosen, RecipeRow, ResolvedRecipe } from './recipe.js';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * A received answer as its note's body: the text, ending in one newline of
 * its own. An empty answer is a newline.
 */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** What is happening to a run in this window. */
export type RunState =
	/** The request is out. */
	| { readonly kind: 'running' }
	/** Nothing was received. Run again sends the same request. */
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * The answer arrived and its note is being created, or `message` says why
	 * it was not. Save again creates it, without another request.
	 */
	| {
			readonly kind: 'unsaved';
			readonly text: string;
			readonly message: string | undefined;
	  };

/** The fields a result note is created with, besides its id and body. */
type TranscriptionFields = {
	recordingId: string;
	createdAt: string;
	model: string;
	endpoint: string;
};
type RecipeFields = {
	transformationId: string;
	transformationTitle: string;
	createdAt: string;
	model: string;
	endpoint: string;
	prompt: string;
	input: string;
};
type Fields =
	| { collection: 'transcriptions'; fields: TranscriptionFields }
	| {
			collection: 'transformation_runs';
			fields: RecipeFields & { recordingId: string; transcriptionId: string };
	  }
	| { collection: 'text_runs'; fields: RecipeFields };

/** A run in this window: what it makes, and how far it got. */
export type Run = Fields & {
	/** The run's key: what it runs on, so the same run does not go twice at once. */
	readonly key: string;
	/** The id its result note is created under, fixed when the run starts. */
	readonly noteId: string;
	/** Where its request goes, fixed when the run starts; none for a run that never started. */
	readonly target: Target | undefined;
	readonly state: RunState;
};

type Answer = Result<{ text: string }, { message: string }>;

const BEING_DELETED = 'This recording is being deleted.';

/** A transcription's key, by the recording it transcribes. */
const transcriptionKey = (recordingId: string) =>
	`transcriptions:${recordingId}`;
/** A transformation run's key, by the transcript and recipe. */
const transformKey = (transcriptionId: string, recipeId: string) =>
	`transformation_runs:${transcriptionId}:${recipeId}`;
/** A pasted-text run's key, by the recipe. */
const textKey = (recipeId: string) => `text_runs:${recipeId}`;

export function createRuns({
	files,
	transcribe,
	transform,
	refused,
	chosen,
	resolve,
	deleting,
}: {
	files: WhisperingFiles;
	/** Send a recording's audio to `target`. Nothing is written by this. */
	transcribe: (
		target: Target,
		audio: () => Promise<Result<Audio, string>>,
	) => Promise<Answer>;
	/** Send instructions and a text to `target`. Nothing is written by this. */
	transform: (
		target: Target,
		request: { prompt: string; input: string },
	) => Promise<Answer>;
	/** Why nothing new starts now, if it does not. */
	refused: () => string | undefined;
	/** The model chosen for transcription now, or why there is none. */
	chosen: (operation: 'transcription') => Chosen;
	resolve: (recipe: RecipeRow | undefined) => ResolvedRecipe;
	/** Recordings whose deletion is under way. No request starts for one. */
	deleting: ReadonlySet<string>;
}) {
	/** Runs with something happening in this window, by key. */
	const runs = new SvelteMap<string, Run>();
	/** Each run's request, to send again. */
	const requests = new Map<string, () => Promise<Answer>>();

	const recordingOf = (run: Fields) =>
		run.collection === 'text_runs' ? undefined : run.fields.recordingId;

	/** Create `run`'s note with `text` as its body; a failure keeps the answer here. */
	async function keep(run: Run, text: string) {
		const unsaved = (message: string | undefined) =>
			runs.set(run.key, { ...run, state: { kind: 'unsaved', text, message } });
		unsaved(undefined);
		if (refused() !== undefined) return;
		const value = { id: run.noteId, ...run.fields, body: resultBody(text) };
		let created: Result<unknown, { name: string; message: string }>;
		try {
			created = await (
				files[run.collection].create as (
					value: unknown,
				) => Promise<Result<unknown, { name: string; message: string }>>
			)(value);
		} catch (cause) {
			created = Err({ name: 'Failed', message: describe(cause) });
		}
		// Occupied: an earlier save of this answer landed, its reply lost.
		if (created.error === null || created.error.name === 'Occupied')
			runs.delete(run.key);
		else unsaved(created.error.message);
	}

	/** Send `run`'s request, then keep its answer. */
	async function send(run: Run, request: () => Promise<Answer>) {
		requests.set(run.key, request);
		const recording = recordingOf(run);
		const why =
			refused() ??
			(recording !== undefined && deleting.has(recording)
				? BEING_DELETED
				: undefined);
		if (why !== undefined) {
			runs.set(run.key, { ...run, state: { kind: 'failed', message: why } });
			return;
		}
		runs.set(run.key, { ...run, state: { kind: 'running' } });
		let answer: Answer;
		try {
			answer = await request();
		} catch (cause) {
			answer = Err({
				message: `The request could not be made: ${describe(cause)}`,
			});
		}
		if (answer.error !== null) {
			runs.set(run.key, {
				...run,
				state: { kind: 'failed', message: answer.error.message },
			});
			return;
		}
		await keep(run, answer.data.text);
	}

	/** Whether a run under `key` is out or keeping its answer, so another does not start. */
	const underWay = (key: string) => {
		const state = runs.get(key)?.state;
		return (
			state?.kind === 'running' ||
			(state?.kind === 'unsaved' && state.message === undefined)
		);
	};

	/** The recipe to send: the one shown, or else its note as listed. */
	function recipeAt(
		id: string,
		shown: RecipeRow | undefined,
	): ResolvedRecipe | string {
		if (shown !== undefined) return resolve(shown);
		const recipe = files.transformations.get({ id });
		if (recipe === undefined)
			return files.transformations.invalid().some((note) => note.id === id)
				? resolve(undefined)
				: 'This transformation is no longer listed.';
		return resolve(recipe);
	}

	/** Start a recipe run whose fields and target `prepare` makes from what it reads now. */
	async function runRecipe(
		key: string,
		prepare: () => (Fields & { target: Target }) | string,
	): Promise<string | undefined> {
		if (underWay(key))
			return 'This transformation is already running on this. Run it again when it has finished.';
		const prepared = prepare();
		if (typeof prepared === 'string') return prepared;
		const at = new Date();
		const run = {
			...prepared,
			key,
			noteId: timeId(at),
			state: { kind: 'running' },
		} as Run;
		const { prompt, input } = run.fields as RecipeFields;
		const { target } = prepared;
		await send(run, () => transform(target, { prompt, input }));
		return undefined;
	}

	return {
		/** The transcription of recording `id` under way, or what became of it. */
		transcriptionRun(id: string): Run | undefined {
			return runs.get(transcriptionKey(id));
		},
		/** Transformation runs on transcript `id` in this window. */
		runsOn(transcriptionId: string): Run[] {
			return [...runs.values()].filter(
				(run) =>
					run.collection === 'transformation_runs' &&
					run.fields.transcriptionId === transcriptionId,
			);
		},
		/** The run of recipe `id` on pasted text in this window. */
		textRun(recipeId: string): Run | undefined {
			return runs.get(textKey(recipeId));
		},
		/** Recipe runs whose request is out. */
		get recipeRuns(): Run[] {
			return [...runs.values()].filter(
				(run) =>
					run.collection !== 'transcriptions' && run.state.kind === 'running',
			);
		},
		/** Answers that arrived and whose note could not be created. */
		get unwritten(): number {
			return [...runs.values()].filter(
				({ state }) => state.kind === 'unsaved' && state.message !== undefined,
			).length;
		},
		/**
		 * Why a recording cannot be deleted now: a request for it is out, or a
		 * result of it is being kept. Either would leave a result naming a
		 * recording that is gone.
		 */
		busy(id: string): string | undefined {
			for (const run of runs.values()) {
				if (recordingOf(run) !== id || !underWay(run.key)) continue;
				return run.collection === 'transcriptions'
					? 'A transcription of this recording is still running. Wait for it to finish, then delete the recording.'
					: 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
			}
			return undefined;
		},
		/** Forget what failed for a deleted recording. */
		dropFailed(id: string) {
			for (const run of runs.values())
				if (recordingOf(run) === id && !underWay(run.key)) {
					runs.delete(run.key);
					requests.delete(run.key);
				}
		},
		/** Forget a failed run, or an answer that was not kept. */
		dismiss(key: string) {
			if (underWay(key)) return;
			runs.delete(key);
			requests.delete(key);
		},
		/** Create the note of an answer that could not be kept, once more. Nothing is sent. */
		async saveAgain(key: string): Promise<void> {
			const run = runs.get(key);
			if (run?.state.kind !== 'unsaved' || run.state.message === undefined)
				return;
			await keep(run, run.state.text);
		},
		/**
		 * Send a failed run's request again, to the target it was made for. An
		 * endpoint removed or moved since fails the run with why, and nothing
		 * is sent. Answers why nothing was tried.
		 */
		async runAgain(key: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const run = runs.get(key);
			const request = requests.get(key);
			if (run?.state.kind !== 'failed' || request === undefined)
				return 'This is already running.';
			await send(run, request);
			return undefined;
		},

		/**
		 * Transcribe recording `id`: send its audio to the transcription model
		 * chosen now, then create its transcript.
		 * Answers why nothing was sent.
		 */
		async transcribe(id: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const key = transcriptionKey(id);
			if (underWay(key)) return 'This recording is already being transcribed.';
			if (deleting.has(id)) return BEING_DELETED;
			const fail = (message: string) => {
				runs.set(key, {
					collection: 'transcriptions',
					fields: {
						recordingId: id,
						createdAt: '',
						model: '',
						endpoint: '',
					},
					key,
					noteId: '',
					target: undefined,
					state: { kind: 'failed', message },
				});
				requests.delete(key);
				return message;
			};
			const choice = chosen('transcription');
			if (choice.kind !== 'ready') return fail(choice.reason);
			const { target } = choice;
			const recording = files.recordings.get({ id });
			if (recording === undefined)
				return fail(
					files.recordings.invalid().some((note) => note.id === id)
						? 'The recording needs repair before it is transcribed.'
						: 'The recording is no longer listed.',
				);
			const audio = files.audioOf(id);
			if (audio.kind !== 'here')
				return fail(
					audio.kind === 'ambiguous'
						? `More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one before transcribing.`
						: 'This recording has no audio to transcribe.',
				);
			const at = new Date();
			const run: Run = {
				collection: 'transcriptions',
				fields: {
					recordingId: id,
					createdAt: at.toISOString(),
					model: target.model,
					endpoint: target.address,
				},
				key,
				noteId: timeId(at),
				target,
				state: { kind: 'running' },
			};
			await send(run, () =>
				transcribe(target, async () => {
					const read = await files.readAudio(id);
					if (read.error !== null) return Err(read.error);
					return Ok({
						bytes: read.data.bytes,
						filename: read.data.name,
						mimeType: read.data.mimeType,
					});
				}),
			);
			return undefined;
		},

		/**
		 * Apply recipe `recipeId` to transcript `transcriptionId`, each as
		 * `shown` or else as listed. Its result is a new note; the transcript
		 * is never changed. Answers why nothing was sent.
		 */
		async transform(
			transcriptionId: string,
			recipeId: string,
			shown: { readonly recipe?: RecipeRow; readonly input?: string } = {},
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			return runRecipe(transformKey(transcriptionId, recipeId), () => {
				const resolved = recipeAt(recipeId, shown.recipe);
				if (typeof resolved === 'string') return resolved;
				if (resolved.kind !== 'ready') return resolved.reason;
				const transcript = files.transcriptions.get({ id: transcriptionId });
				if (transcript === undefined)
					return 'This transcript is no longer listed.';
				const input = shown.input ?? transcript.body;
				if (input.trim() === '')
					return 'This transcript has no text to transform.';
				if (deleting.has(transcript.recordingId)) return BEING_DELETED;
				return {
					collection: 'transformation_runs',
					target: resolved.target,
					fields: {
						recordingId: transcript.recordingId,
						transcriptionId,
						transformationId: recipeId,
						transformationTitle: resolved.title,
						createdAt: new Date().toISOString(),
						model: resolved.target.model,
						endpoint: resolved.target.address,
						prompt: resolved.prompt,
						input,
					},
				};
			});
		},

		/**
		 * Apply recipe `recipeId`, as `shown` or else as listed, to pasted text
		 * taken as it is now. Its result is a new note in `text_runs/`. Answers
		 * why nothing was sent.
		 */
		async transformText(
			recipeId: string,
			input: string,
			shown: { readonly recipe?: RecipeRow } = {},
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			if (input.trim() === '') return 'Paste some text to run this on.';
			return runRecipe(textKey(recipeId), () => {
				const resolved = recipeAt(recipeId, shown.recipe);
				if (typeof resolved === 'string') return resolved;
				if (resolved.kind !== 'ready') return resolved.reason;
				return {
					collection: 'text_runs',
					target: resolved.target,
					fields: {
						transformationId: recipeId,
						transformationTitle: resolved.title,
						createdAt: new Date().toISOString(),
						model: resolved.target.model,
						endpoint: resolved.target.address,
						prompt: resolved.prompt,
						input,
					},
				};
			});
		},
	};
}

export type Runs = ReturnType<typeof createRuns>;
