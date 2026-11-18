/**
 * Whispering for one mounted page: the models it can reach, the microphone,
 * and the recorder, over the capabilities `src/lib/app.ts` opened. What the
 * folder shows is the library's (`library.svelte.ts`); both write through
 * the same folder.
 *
 * Where a take is kept while it records depends on where the page runs
 * (ADR-0779, ADR-0780): the desktop shell encodes it into the data folder
 * from the first sample, and on the next launch finishes, in the
 * background, what a quit or a crash cut off (`capture.recover`); a browser
 * keeps it in the page's memory and writes it once at Stop, so a crash or a
 * closed tab loses it. Stop answers once its audio is at its path, and its
 * note is written then. Audio whose note was not written, or that a crash
 * cut off, lists as an untitled recording (ADR-0894).
 *
 * The models are the page's one merge of endpoints (`ai`, ADR-0757): the
 * connections the person saved, then what runs on this computer, each
 * followed as it changes. The person chooses one model for transcription
 * and one for text, in `settings.md`; a request captures that choice when
 * it is prepared and goes there alone (`inference.ts`).
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Ai, ModelChoice } from '@epicenter/ai';
import { createContext } from 'svelte';
import type { Result } from 'wellcrafted/result';
import type { Capture, CaptureDevice } from './capture.js';
import type { WhisperingFolder } from './folder.svelte.js';
import { timeId } from './format/ids.js';
import {
	type Audio,
	addressOf,
	type Target,
	transcribeAt,
	transformAt,
} from './inference.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { MicrophonePreferences } from './microphone-preference.js';
import { reactive } from './reactive.js';
import {
	type Chosen,
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import type { Settings } from './settings.svelte.js';

/** What a model is chosen for: transcribing a recording, or running a transformation on text. */
export type Operation = 'transcription' | 'text';

/** What a model must be able to do to be chosen for each operation. */
export const CAN = { transcription: 'transcribe', text: 'chat' } as const;

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

const CLOSING = 'Whispering is closing, so nothing was changed.';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

function defaultTitle(at: Date): string {
	return `Recording ${at.toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})}`;
}

/** What Whispering is made over: the capabilities `src/lib/app.ts` opened, or a test's. */
export type WhisperingCapabilities = {
	/** Whispering's folder, which every recording and its note is written into. */
	readonly folder: Pick<WhisperingFolder, 'recordings' | 'listAudio'>;
	/** Every model this page reaches, in the picker's order. */
	readonly ai: Ai;
	/** The model chosen for each job, in `settings.md`. */
	readonly choices: Settings['choices'];
	/** What records each recording into `folder`. */
	readonly capture: CaptureDevice;
	/**
	 * What this device remembers that is neither a file nor a secret: the
	 * microphone chosen. It is never written to Whispering's files.
	 */
	readonly preferences: MicrophonePreferences;
};

export function createWhispering(capabilities: WhisperingCapabilities) {
	const { folder: files, capture, preferences } = capabilities;
	/** Whether the sidebar is open on a wide window. Held here so no page owns it. */
	let sidebarOpen = $state(false);

	/** Cleanup also fences new work and late replies. */
	let disposed = false;
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- models, microphone -------------------------------------------------

	/** Every model this page can reach, in the picker's order; sign-in and a saved connection reach it as they happen. */
	const ai = reactive(capabilities.ai);
	/** The model chosen for each job: Svelte state, read when the folder was. */
	const { choices } = capabilities;
	/** Why the saved connections do not read, naming the file, if they do not; tracks in Svelte. */
	const connectionsProblem = () => ai.custom()?.problem()?.message;

	/** The model chosen for `operation` now, as where a request would go, or why there is none. */
	function chosen(operation: Operation): Chosen {
		const decided = choices.require(CAN[operation]);
		if (decided.error?.name === 'Invalid')
			return { kind: 'unset', reason: decided.error.message };
		const choice = decided.data;
		if (choice === null)
			return {
				kind: 'unset',
				reason:
					operation === 'transcription'
						? 'No transcription model is chosen, so nothing was sent. Choose one in Settings, then transcribe.'
						: 'Choose a text model in Settings to run this.',
			};
		const endpoint = ai
			.endpoints()
			.find((candidate) => candidate.id === choice.endpoint);
		if (endpoint === undefined)
			return {
				kind: 'unset',
				reason: `The ${operation} model chosen, ${choice.model}, is at an endpoint that is not set up on this computer${
					connectionsProblem() === undefined ? '' : ` (${connectionsProblem()})`
				}. Choose a model in Settings.`,
			};
		const target: Target = {
			endpoint: endpoint.id,
			model: choice.model,
			name: endpoint.name,
			address: addressOf(endpoint),
		};
		return { kind: 'ready', target };
	}

	function resolve(recipe: RecipeRow | undefined): ResolvedRecipe {
		return resolveRecipe(recipe, chosen('text'));
	}

	/** Choose the model `operation` uses from now on. Nothing is sent. */
	async function choose(
		operation: Operation,
		choice: ModelChoice,
	): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		const saved = await choices.set(CAN[operation], choice);
		return saved.error?.message;
	}

	/** Send audio to `target`, through the endpoints merged when it is sent. */
	const transcribe = (
		target: Target,
		audio: () => Promise<Result<Audio, string>>,
	) => transcribeAt(() => ai, target, audio);

	/** Send a transformation to `target`, through the endpoints merged when it is sent. */
	const transform = (
		target: Target,
		request: { prompt: string; input: string },
	) => transformAt(() => ai, target, request);

	/** A capture under way, writing recording `id`'s audio. */
	type Take = { id: string; capture: Capture };
	type CaptureState =
		| { phase: 'idle' }
		| { phase: 'starting'; attempt: AbortController }
		| { phase: 'recording'; at: Date; take: Take }
		| { phase: 'stopping' };
	let captureState = $state.raw<CaptureState>({ phase: 'idle' });
	/** The last Stop until it has finished, its note written included. */
	let finishing: Promise<void> | undefined;
	let recorderError = $state<string | undefined>();

	const input = createMicrophoneInput({
		capture,
		preferences,
		recording: () => captureState.phase !== 'idle',
	});
	// The saved choice only: no microphone is opened or listed at launch.
	input.load();

	// --- recording ----------------------------------------------------------

	/**
	 * Stop: release the microphone and finish the audio at its path, then
	 * write its note. Once closed, nothing more is done here: what was
	 * written stays, and lists as an untitled recording.
	 */
	function finishRecording(): Promise<void> {
		const current = captureState;
		if (current.phase !== 'recording' || disposed)
			return finishing ?? Promise.resolve();
		captureState = { phase: 'stopping' };
		const finished = finish(current);
		finishing = finished;
		const forget = () => {
			if (finishing === finished) finishing = undefined;
		};
		finished.then(forget, forget);
		return finished;
	}

	async function finish({
		at,
		take,
	}: Extract<CaptureState, { phase: 'recording' }>) {
		const { data: stopped, error } = await take.capture
			.stop()
			.catch((cause) => ({
				data: null,
				error: { message: describe(cause) },
			}));
		captureState = { phase: 'idle' };
		if (disposed) return;
		// Nothing is in the library yet, so a failure leaves nothing to undo:
		// whatever audio was written lists as an untitled recording.
		if (error !== null) {
			recorderError = error.message;
			void files.listAudio();
			return;
		}
		// The audio is at its path, so its note goes after it.
		const [kept] = await Promise.all([
			files.recordings.set(
				{ id: take.id },
				{
					title: defaultTitle(at),
					recordedAt: at.toISOString(),
					durationMs: Math.max(0, Math.round(stopped.durationMs)),
				},
			),
			files.listAudio(),
		]);
		if (kept.error !== null && !disposed)
			recorderError = `The recording's audio is saved, but its note was not: ${kept.error.message} It is listed as an untitled recording.`;
	}

	/**
	 * On the desktop, finish every take a quit or a crash cut short and place
	 * it in the folder, where it lists as an untitled recording. It runs
	 * once, beside the pages. What cannot be completed is said and left for
	 * the next launch. A take kept outside the folder because audio with its
	 * id is there is said with where it is, on every launch until a person
	 * moves one of the two. A browser keeps nothing through a crash, so it
	 * has none to finish (ADR-0780).
	 */
	async function completeCutOffRecordings(
		recover: NonNullable<CaptureDevice['recover']>,
	) {
		const { data, error } = await recover();
		if (disposed) return;
		if (error !== null) {
			recorderError = `Recordings a quit or a crash cut off could not be completed: ${error.message}`;
			return;
		}
		if (data.recovered.length > 0) void files.listAudio();
		if (data.unplaced.length > 0)
			recorderError = `A recording is kept outside the library, because audio with its id is already there: ${data.unplaced
				.map(
					({ id, take }) =>
						`recordings/${id}.webm is another file, and the recording is at ${take}`,
				)
				.join('; ')}. Move the other file, and the next start adds it.`;
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		input.close();
		if (captureState.phase === 'starting') {
			captureState.attempt.abort();
			captureState = { phase: 'idle' };
		}
	}

	if (capture.recover) void completeCutOffRecordings(capture.recover);

	return {
		/** Whether the sidebar is open on a wide window. */
		get sidebarOpen() {
			return sidebarOpen;
		},
		set sidebarOpen(open: boolean) {
			sidebarOpen = open;
		},
		/** Every model this page can reach now, with the person's connections, for the picker; tracks in Svelte. */
		ai,
		/** Why the saved connections do not read, naming the file, if they do not. */
		get connectionsProblem() {
			return connectionsProblem();
		},
		/** The model chosen for `operation`, or null when none is. */
		choice(operation: Operation): ModelChoice | null {
			return choices.get(CAN[operation]);
		},
		choose,
		chosen,
		/**
		 * Whether a recipe can run now, and with what: the one decision the Run
		 * button, the post-processing choice, a transcript's menu, and the run
		 * itself all use. Undefined is a recipe whose note does not read.
		 */
		resolve,
		transcribe,
		transform,
		/** Why nothing new starts now, if it does not: Whispering is closing. */
		refused,
		/** The microphone the next recording uses, and the test of it. */
		input,

		// ------------------------------------------------------------------
		// Starting and closing
		// ------------------------------------------------------------------

		get closing() {
			return disposed;
		},
		/**
		 * Stop new work and late answers, and release the microphone this page
		 * opened for a test; waits for nothing. A recording opening now is
		 * released when it answers; one under way ends with the page.
		 */
		dispose,

		// ------------------------------------------------------------------
		// Recording
		// ------------------------------------------------------------------

		get recorder(): RecorderState {
			return captureState.phase === 'recording'
				? { phase: 'recording', startedAt: captureState.take.capture.startedAt }
				: { phase: captureState.phase };
		},
		get recorderError() {
			return recorderError;
		},
		/**
		 * Start a recording from the chosen microphone. Its audio is written
		 * into the files as it records; its note waits for Stop.
		 */
		async startRecording() {
			if (captureState.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			const attempt = new AbortController();
			const at = new Date();
			const id = timeId(at);
			captureState = { phase: 'starting', attempt };
			input.release();
			const { data: started, error } = await capture.start({
				id,
				input: input.choice,
				signal: attempt.signal,
			});
			// Closed while the microphone was opening: an aborted opener releases it.
			if (attempt.signal.aborted || disposed) {
				captureState = { phase: 'idle' };
				return;
			}
			if (error !== null) {
				captureState = { phase: 'idle' };
				recorderError = error.message;
				input.noteRecordingError(error);
				return;
			}
			const take = { id, capture: started };
			captureState = { phase: 'recording', at, take };
			take.capture.onEnded((reason) => {
				if (captureState.phase !== 'recording' || captureState.take !== take)
					return;
				recorderError = {
					deviceDisconnected:
						'The microphone was disconnected. Recording stopped.',
					permissionRevoked:
						'Microphone permission was revoked. Recording stopped.',
					streamFailed: 'The microphone stream failed. Recording stopped.',
					storageFailed: 'Audio storage failed. Recording stopped.',
				}[reason];
				// Stop keeps what was captured.
				void finishRecording();
			});
		},
		/** Stop: the microphone is released, the audio finished at its path, and its note written. */
		stopRecording: finishRecording,
	};
}

export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
