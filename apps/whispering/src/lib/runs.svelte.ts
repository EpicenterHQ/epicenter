/**
 * Requests to an endpoint and the results they make: transcriptions of a
 * recording, and recipe runs on a transcript or on pasted text.
 *
 * A run sends its request, then saves the answer as a new result note,
 * every field fixed and the answer as its body, through the folder query's
 * writes. So a result note always holds an answer. A run's state is kept
 * here until it is saved:
 *
 * - `running`: the request is out.
 * - `failed`: nothing was received. Run again sends the same request, to
 *   the target fixed when it was prepared.
 * - `saving`: the answer arrived and its note is being written.
 * - `unsaved`: the answer's note could not be written. Save again writes
 *   the same text; nothing is sent.
 *
 * This is Svelte state on purpose, as an editor's typing is: an answer not
 * yet saved belongs to the window showing it, not to the folder or the
 * query cache. A saved run is forgotten; a failed one stays until the
 * person dismisses it or runs it again. A reload loses them. Waiting for
 * an endpoint never delays closing; an answer that arrives after closing
 * keeps nothing.
 *
 * What a run sends is prepared before it starts (`RunRequest`): the
 * recording's audio file, or the recipe and text as shown, and the target
 * chosen then. Nothing here reads the folder to decide.
 */
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AudioFile, WhisperingFolder } from './folder.js';
import type { FolderQuery } from './folder-query.js';
import type { Audio, Target } from './inference.js';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * A received answer as its note's body: the text, ending in one newline of
 * its own. An empty answer is a newline.
 */
const resultBody = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

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
	| {
			collection: 'transcriptions';
			fields: TranscriptionFields;
			/** The recording's audio file, found when the run was prepared. */
			audio: AudioFile;
	  }
	| {
			collection: 'transformation_runs';
			fields: RecipeFields & { recordingId: string; transcriptionId: string };
	  }
	| { collection: 'text_runs'; fields: RecipeFields };

/** A request prepared to be sent, every part fixed when it was prepared. */
export type RunRequest = Fields & {
	/** What it runs on, so the same run does not go twice at once. */
	readonly key: string;
	/** The id its result note is created under. */
	readonly noteId: string;
	/** Where its request goes. */
	readonly target: Target;
};

/** What is happening to a run in this window. */
export type RunState =
	/** The request is out. */
	| { readonly kind: 'running' }
	/** Nothing was received. Run again sends the same request. */
	| { readonly kind: 'failed'; readonly message: string }
	/** The answer arrived and its note is being written; the run ends when it lands. */
	| { readonly kind: 'saving' }
	/** The answer arrived and its note could not be written. Save again writes it; nothing is sent. */
	| {
			readonly kind: 'unsaved';
			readonly text: string;
			readonly message: string;
	  };

/** A run in this window: what it sends and makes, and how far it got. */
export type Run = RunRequest & { readonly state: RunState };

type Answer = Result<{ text: string }, { message: string }>;

/** The recording a run is for, or undefined for a run on pasted text. */
const recordingOf = (run: RunRequest) =>
	run.collection === 'text_runs' ? undefined : run.fields.recordingId;

const underWayIn = ({ state }: Run) =>
	state.kind === 'running' || state.kind === 'saving';

export function createRuns({
	folder,
	query,
	transcribe,
	transform,
	refused,
}: {
	/** Where a recording's audio is read from. */
	folder: Pick<WhisperingFolder, 'readAudio'>;
	/** Where result notes are written. */
	query: Pick<FolderQuery, 'setNote'>;
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
}) {
	const runs = new SvelteMap<string, Run>();
	const put = (request: RunRequest, state: RunState) =>
		runs.set(request.key, { ...request, state });

	/** Ask the endpoint; the answer's text, or why none came. */
	async function send(request: RunRequest): Promise<Answer> {
		try {
			if (request.collection === 'transcriptions') {
				const { audio } = request;
				return await transcribe(request.target, async () => {
					const read = await folder.readAudio(audio);
					if (read.error !== null) return Err(read.error);
					return Ok({
						bytes: read.data.bytes,
						filename: read.data.name,
						mimeType: read.data.mimeType,
					});
				});
			}
			const { prompt, input } = request.fields;
			return await transform(request.target, { prompt, input });
		} catch (cause) {
			return Err({
				message: `The request could not be made: ${describe(cause)}`,
			});
		}
	}

	/** Write `text` as `request`'s result note; the run ends when it lands. */
	async function save(request: RunRequest, text: string) {
		put(request, { kind: 'saving' });
		const saved = await query.setNote(request.collection, request.noteId, {
			...request.fields,
			body: resultBody(text),
		});
		if (saved.error === null) runs.delete(request.key);
		else put(request, { kind: 'unsaved', text, message: saved.error.message });
	}

	async function start(request: RunRequest) {
		put(request, { kind: 'running' });
		const answer = await send(request);
		if (answer.error !== null)
			return void put(request, {
				kind: 'failed',
				message: answer.error.message,
			});
		if (refused() !== undefined) return void runs.delete(request.key);
		await save(request, answer.data.text);
	}

	return {
		/** Every run in this window, each as its latest state; read reactively. */
		list: (): Run[] => [...runs.values()],
		/** Whether a run under `key` is out or writing its answer, so another does not start. */
		underWay(key: string): boolean {
			const run = runs.get(key);
			return run !== undefined && underWayIn(run);
		},
		/** Send `request`, then save its answer; settles when both are done or one failed. */
		start,
		/**
		 * Send a failed run's request again, to the target it was prepared
		 * for; the endpoint refuses one removed or moved since. An unsaved
		 * answer is written again instead, and nothing is sent. Answers why
		 * nothing was tried.
		 */
		async again(key: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const run = runs.get(key);
			if (run === undefined) return 'This run is no longer in this window.';
			const { state, ...request } = run;
			if (state.kind === 'unsaved') await save(request, state.text);
			else if (state.kind === 'failed') await start(request);
			else return 'This is already running.';
			return undefined;
		},
		/** Forget a failed run, or an answer that was not saved. */
		dismiss(key: string) {
			const run = runs.get(key);
			if (run !== undefined && !underWayIn(run)) runs.delete(key);
		},
		/**
		 * Why a recording cannot be deleted now: a request for it is out, a
		 * result of it is being written, or an answer for it waits to be saved
		 * again. Each would leave a result naming a recording that is gone.
		 */
		busy(recordingId: string): string | undefined {
			for (const run of runs.values()) {
				if (recordingOf(run) !== recordingId) continue;
				if (run.state.kind === 'unsaved')
					return 'An answer for this recording was not saved. Save it again or discard it, then delete the recording.';
				if (run.state.kind === 'failed') continue;
				return run.collection === 'transcriptions'
					? 'A transcription of this recording is still running. Wait for it to finish, then delete the recording.'
					: 'A transformation of this recording’s transcript is still running. Wait for it to finish, then delete the recording.';
			}
			return undefined;
		},
		/** Forget the failed runs of a deleted recording. */
		forgetRecording(recordingId: string) {
			for (const run of [...runs.values()])
				if (recordingOf(run) === recordingId && !underWayIn(run))
					runs.delete(run.key);
		},
	};
}
