/**
 * Whispering for one mounted page: the models it can reach, the microphone,
 * and the recorder, over the capabilities `src/lib/app.ts` opened. What the
 * folder shows is the library's (`library.svelte.ts`); both write through
 * the same folder.
 *
 * Where a take is kept while it records depends on where the page runs
 * (ADR-0779, ADR-0780): the desktop shell encodes it at its path in the
 * folder from its first second (ADR-0962); a browser keeps it in the page's
 * memory and writes it once at Stop, so a crash or a closed tab loses it.
 * Stop answers once its audio is at its path, and its note is written
 * then. The library leaves the take out until its note is written
 * (`takeInProgress`). Audio whose note was not written, or that a crash cut
 * off, lists as an untitled recording (ADR-0894).
 *
 * The models are the page's one merge of endpoints (`ai`, ADR-0757): the
 * connections the person saved, then what runs on this computer, each
 * followed as it changes. The person chooses one model for transcription,
 * in `settings.md`; a request captures that choice when it is prepared and
 * goes there alone (`inference.ts`).
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Ai, ModelChoice } from '@epicenter/ai';
import { createQuery } from '@tanstack/svelte-query';
import { createContext } from 'svelte';
import { runMutation } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Capture, CaptureDevice } from './capture.js';
import type { FolderQuery } from './folder-query.js';
import { timeId } from './format/ids.js';
import {
	type Audio,
	addressOf,
	type Target,
	transcribeAt,
} from './inference.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { MicrophonePreferences } from './microphone-preference.js';
import { reactive } from './reactive.js';
import { sentences } from './sentences.js';
import { chosenIn, NO_SETTINGS } from './settings.js';

type RecorderState =
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
	/** Whispering's folder as the page's client reads and writes it: every recording's note, and `settings.md`, go through it. */
	readonly query: Pick<
		FolderQuery,
		'queryClient' | 'folderMutations' | 'reread' | 'settingsQueries'
	>;
	/** Every model this page reaches, in the picker's order. */
	readonly ai: Ai;
	/** What records each recording into `folder`. */
	readonly capture: CaptureDevice;
	/**
	 * What this device remembers that is neither a file nor a secret: the
	 * microphone chosen. It is never written to Whispering's files.
	 */
	readonly preferences: MicrophonePreferences;
};

export function createWhispering(capabilities: WhisperingCapabilities) {
	const { query, capture, preferences } = capabilities;
	/** Whether the sidebar is open on a wide window. Held here so no page owns it. */
	let sidebarOpen = $state(false);

	/** Cleanup also fences new work and late replies. */
	let disposed = false;
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- models, microphone -------------------------------------------------

	/** Every model this page can reach, in the picker's order; sign-in and a saved connection reach it as they happen. */
	const ai = reactive(capabilities.ai);
	/** `settings.md` as its query last read it: the model chosen for each job. */
	const settingsRead = createQuery(
		() => query.settingsQueries.get(),
		() => query.queryClient,
	);
	const settings = () => settingsRead.data ?? NO_SETTINGS;
	/** Why the saved connections do not read, naming the file, if they do not; tracks in Svelte. */
	const connectionsProblem = () => ai.custom()?.problem()?.message;

	/** The transcription model chosen now, as where a request would go, or why there is none. */
	function chosen(): Result<Target, string> {
		const { data: choice, error } = chosenIn(settings(), 'transcribe');
		if (error?.name === 'Invalid') return Err(error.message);
		if (choice === null)
			return Err(
				'No transcription model is chosen, so nothing was sent. Choose one in Settings, then transcribe.',
			);
		const endpoint = ai
			.endpoints()
			.find((candidate) => candidate.id === choice.endpoint);
		if (endpoint === undefined)
			return Err(
				`The transcription model chosen, ${choice.model}, is at an endpoint that is not set up on this computer${
					connectionsProblem() === undefined ? '' : ` (${connectionsProblem()})`
				}. Choose a model in Settings.`,
			);
		return Ok({
			endpoint: endpoint.id,
			model: choice.model,
			name: endpoint.name,
			address: addressOf(endpoint),
		});
	}

	/** Choose the transcription model from now on. Nothing is sent. */
	async function choose(choice: ModelChoice): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		const saved = await runMutation(
			query.queryClient,
			query.folderMutations.settings.set,
			{
				models: {
					...settings().fields.models,
					transcribe: { endpoint: choice.endpoint, model: choice.model },
				},
			},
		);
		return saved.error?.message;
	}

	/** Send `audio` to `target`, through the endpoints merged when it is sent. */
	const transcribe = (target: Target, audio: Audio) =>
		transcribeAt(() => ai, target, audio);

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
	/**
	 * The recording whose take is under way, from Start until its note is
	 * written or its Stop failed. On the desktop its audio is at its path
	 * all that time, and the library leaves it out.
	 */
	let takeInProgress = $state<string | undefined>();
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
			takeInProgress = undefined;
			recorderError = error.message;
			void query.reread();
			return;
		}
		// The audio is at its path, so its note goes after it; writing the
		// note reads the folder again, the audio with it.
		const kept = await runMutation(
			query.queryClient,
			query.folderMutations.notes.set,
			{
				collection: 'recordings',
				id: take.id,
				fields: {
					title: defaultTitle(at),
					recordedAt: at.toISOString(),
					durationMs: Math.max(0, Math.round(stopped.durationMs)),
				},
			},
		);
		takeInProgress = undefined;
		if (kept.error !== null && !disposed)
			recorderError = sentences(
				`The recording's audio is saved, but its note was not: ${kept.error.message}`,
				'It is listed as an untitled recording.',
			);
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
		/** The transcription model chosen, or null when none is. */
		choice(): ModelChoice | null {
			return chosenIn(settings(), 'transcribe').data ?? null;
		},
		choose,
		chosen,
		transcribe,
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
		/** The recording whose take is under way, which the library leaves out until its note is written; tracks in Svelte. */
		get takeInProgress() {
			return takeInProgress;
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
			takeInProgress = id;
			input.release();
			const { data: started, error } = await capture.start({
				id,
				input: input.choice,
				signal: attempt.signal,
			});
			// Closed while the microphone was opening: an aborted opener releases it.
			if (attempt.signal.aborted || disposed) {
				captureState = { phase: 'idle' };
				takeInProgress = undefined;
				return;
			}
			if (error !== null) {
				captureState = { phase: 'idle' };
				takeInProgress = undefined;
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
