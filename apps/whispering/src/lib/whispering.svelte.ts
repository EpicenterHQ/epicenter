/**
 * Whispering for one mounted page: the models it can reach, the microphone,
 * and the recorder, over the capabilities `src/lib/app.ts` opened. What the
 * files show is the library's (`library.svelte.ts`); both write through the
 * same folder, so the folder's `saving()` counts every note either writes.
 *
 * A recording is written into the folder as it records (decision 84): the
 * desktop shell encodes it into the data folder from the first sample, a
 * browser appends each piece to this browser's files as it arrives. Stop
 * answers once its audio is at its path, and its note is written then
 * (`folder-recordings.ts`). Starting first completes what a quit, a crash,
 * or a closed tab cut off and gives it a note, before any page lists,
 * plays, or transcribes a recording; that waits through the folder's own
 * listing, never on its `state()`. Where the folder keeps no files (a
 * private window), the browser's recorder refuses before any microphone
 * opens. Recording never waits on the network, and nothing kept here ever
 * moves (ADR-0700).
 *
 * The models are the build's one merge of endpoints (`ai`, ADR-0757):
 * Epicenter's hosted models through the account signed in now, the
 * connections the person saved with their keys, then what runs on this
 * computer, each followed as it changes. The person chooses one model for
 * transcription and one for text; a request captures that choice when it is
 * prepared and goes there alone (`inference.ts`).
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Ai, ModelChoice, ModelChoices } from '@epicenter/ai';
import { timeId } from '@epicenter/definition/ids';
import type { Folder } from '@epicenter/folder/core';
import { reactive } from '@epicenter/svelte/reactive';
import { createContext } from 'svelte';
import type { Result } from 'wellcrafted/result';
import type { Capture, CaptureDevice } from './capture.js';
import type { Whispering as WhisperingContract } from './contract.js';
import { finishCutOffRecordings, keepRecording } from './folder-recordings.js';
import {
	type Audio,
	addressOf,
	type Target,
	transcribeAt,
	transformAt,
} from './inference.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { MicrophonePreferences } from './microphone-preference.js';
import {
	type Chosen,
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';

/** What a model is chosen for: transcribing a recording, or running a transformation on text. */
export type Operation = 'transcription' | 'text';

/** What a model must be able to do to be chosen for each operation. */
export const CAN = { transcription: 'transcribe', text: 'chat' } as const;

export const STOPPED = 'Whispering stopped before it finished starting.';

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
	readonly folder: Folder<WhisperingContract>;
	/** Every model this page reaches, in the picker's order. */
	readonly ai: Ai;
	/** This computer's model for each job. */
	readonly choices: ModelChoices<'transcribe' | 'chat'>;
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
	let starting: Promise<void> | undefined;

	/** Cleanup also fences new work and late replies. */
	let disposed = false;
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- models, microphone -------------------------------------------------

	let stopChoices: (() => void) | undefined;
	let chosenModels = $state.raw<Record<Operation, ModelChoice | null>>({
		transcription: null,
		text: null,
	});

	/** Every model this page can reach, in the picker's order; sign-in and a saved connection reach it as they happen. */
	const ai = reactive(capabilities.ai);
	/** Why the saved connections could not be read, if they could not; tracks in Svelte. */
	const connectionsProblem = () => ai.custom()?.problem() ?? undefined;

	/** The model chosen for `operation` now, as where a request would go, or why there is none. */
	function chosen(operation: Operation): Chosen {
		const choice = chosenModels[operation];
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
				reason: `The ${operation} model chosen, ${choice.model}, is at an endpoint that is not set up on this device${
					connectionsProblem() === undefined
						? ''
						: ` (the saved connections could not be read: ${connectionsProblem()})`
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

	/** Read this device's model choices (kept by job, `CAN`'s), and follow them as they change. */
	async function readChoices() {
		const { choices } = capabilities;
		const read = () => {
			chosenModels = {
				transcription: choices.get(CAN.transcription),
				text: choices.get(CAN.text),
			};
		};
		stopChoices = choices.subscribe(read);
		read();
		await choices.ready;
		read();
	}

	/** Choose the model `operation` uses from now on. Nothing is sent. */
	async function choose(
		operation: Operation,
		choice: ModelChoice,
	): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		try {
			await capabilities.choices.set(CAN[operation], choice);
			return undefined;
		} catch (cause) {
			return describe(cause);
		}
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

	// --- recording ----------------------------------------------------------

	/**
	 * Stop: release the microphone and finish the audio at its path, then
	 * write its note. Once closed, nothing more is done here: what was
	 * written stays, and the next start gives it its note.
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
		// whatever audio was written, the next start gives it its note, or
		// says where it is kept when another file took its path.
		if (error !== null) {
			recorderError = error.message;
			return;
		}
		// The audio is at its path, so its note goes after it, and lands in
		// order: the folder keeps it until it does (ADR-0775).
		await keepRecording(files, {
			id: take.id,
			title: defaultTitle(at),
			recordedAt: at.toISOString(),
			durationMs: stopped.durationMs,
		});
	}

	/**
	 * Repair the audio a quit, a crash, or a closed tab cut off, then give
	 * each such recording its note. Nothing records here yet, and a
	 * recording another tab is still writing is left alone. What cannot be
	 * completed is said and left for the next start; it never stops
	 * Whispering from starting. A recording kept outside its path because
	 * another file is there is said with where its audio is, on every start
	 * until a person moves one of the two. Files that cannot be listed at
	 * all (a private window keeps none) are not said here: the banner over
	 * every page says it, from the library's own listing.
	 */
	async function completeCutOffRecordings() {
		const { data, error } = await finishCutOffRecordings(files, capture);
		if (disposed) return;
		if (error !== null) {
			if (error.name !== 'Unavailable')
				recorderError = `Recordings a quit or a crash cut off could not be completed: ${error.message}`;
			return;
		}
		if (data.unplaced.length > 0)
			recorderError = `A recording is kept outside the library, because another file is at its path: ${data.unplaced
				.map(
					({ path, pending }) =>
						`its audio is at ${pending} in this folder, and ${path} is another file`,
				)
				.join('; ')}. Move the other file, and the next start adds it.`;
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		input.close();
		stopChoices?.();
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
		/** Why the saved connections could not be read, if they could not. */
		get connectionsProblem() {
			return connectionsProblem();
		},
		/** The model chosen for `operation`, or null when none is. */
		choice(operation: Operation): ModelChoice | null {
			return chosenModels[operation];
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
		 * Read the model choices, the saved connections and the saved
		 * microphone choice, and complete the recordings a quit, a crash, or a
		 * closed tab cut off. Nothing is sent to an endpoint. The app shows its
		 * pages once this has answered, so nothing lists, plays, or transcribes
		 * a recording before it is complete.
		 */
		start(): Promise<void> {
			starting ??= (async () => {
				try {
					if (disposed) throw new Error(STOPPED);
					await readChoices();
					await ai.custom()?.ready;
					// The saved choice only: no microphone is opened or listed at launch.
					if (disposed) throw new Error(STOPPED);
					await input.load();
					if (disposed) throw new Error(STOPPED);
					await completeCutOffRecordings();
					if (disposed) throw new Error(STOPPED);
				} catch (cause) {
					const stopped = disposed;
					dispose();
					throw stopped ? new Error(STOPPED) : cause;
				}
			})();
			return starting;
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

		/** Read the saved connections again, as after a failed read. */
		readConnections: () => ai.custom()?.reopen() ?? Promise.resolve(),
	};
}

export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
