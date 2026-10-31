/**
 * Whispering for one mounted page: the services, the connections, the
 * microphone, and the recorder. What the files show is the library's
 * (`library.svelte.ts`); both write through the same client, which the
 * variant root chose (`#platform/root`'s `Startup`).
 *
 * A recording is written into the client's files as it records (decision
 * 84): the desktop shell writes a WAV into the data folder from the first
 * sample, a browser appends each piece to this browser's files as it
 * arrives. So its note is made when it starts and completed with its length
 * when it stops (`folder-recordings.ts`), and a start first completes what a
 * quit, a crash, or a closed tab cut off. Where the client keeps no files (a
 * private window), recording is refused before any microphone opens.
 * Recording never waits on the network, and nothing kept here ever moves
 * (ADR-0700).
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Client } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { holdLeave } from '@epicenter/svelte/leave-guard';
import { createContext } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createServices } from '#platform/services';
import type { Capture, CaptureError } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import type { Whispering as WhisperingContract } from './contract.js';
import {
	abandonRecording,
	beginRecording,
	completeRecording,
	finishCutOffRecordings,
} from './folder-recordings.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { createSettingsDraft } from './settings-draft.svelte.js';

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

export function createWhispering({
	client,
}: {
	/** Whispering's files, where every recording is kept. */
	client: Client<WhisperingContract>;
}) {
	const services = createServices(client);
	/** Whether the sidebar is open on a wide window. Held here so no page owns it. */
	let sidebarOpen = $state(false);
	let starting: Promise<void> | undefined;

	/** Cleanup also fences new work and late replies. */
	let disposed = false;
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- connections, microphone -------------------------------------------------

	/** What the device has set up, never a key; undefined until read or when the read failed. */
	let connections = $state.raw<ConnectionsInfo | undefined>();
	let connectionsError = $state<string | undefined>();
	let connectionReadId = 0;

	function resolve(recipe: RecipeRow | undefined): ResolvedRecipe {
		return resolveRecipe(recipe, connections?.text, connectionsError);
	}

	async function readConnections() {
		const current = ++connectionReadId;
		try {
			const read = await services.connections.read();
			if (disposed || current !== connectionReadId) return;
			connections = read;
			connectionsError = undefined;
		} catch (cause) {
			if (disposed || current !== connectionReadId) return;
			connections = undefined;
			connectionsError = describe(cause);
		}
	}

	/** A capture under way, writing recording `id`'s audio. */
	type Take = { id: string; capture: Capture };
	type CaptureState =
		| { phase: 'idle' }
		| { phase: 'starting'; attempt: AbortController }
		| { phase: 'recording'; at: Date; take: Take }
		| { phase: 'stopping'; at: Date; take: Take };
	let captureState = $state.raw<CaptureState>({ phase: 'idle' });
	/**
	 * The last Stop until it has finished, the recording kept included,
	 * though the microphone is free sooner. A Stop pressed again joins it.
	 */
	let finishing: Promise<void> | undefined;
	let recorderError = $state<string | undefined>();

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => captureState.phase !== 'idle',
	});

	// --- recording ----------------------------------------------------------

	/**
	 * Open the microphone for a recording made at `at`. Its note is made
	 * first, and removed again when the microphone does not open.
	 */
	async function startTake(
		at: Date,
		signal: AbortSignal,
	): Promise<Result<Take, { message: string; capture?: CaptureError }>> {
		const capture = services.capture;
		const id = timeId(at);
		const made = await holdLeave(
			beginRecording(client, {
				id,
				title: defaultTitle(at),
				recordedAt: at.toISOString(),
				capture: capture.source,
			}),
		);
		if (made.error !== null)
			return Err({ message: `The recording could not start: ${made.error}` });
		const { data, error } = await capture.start({
			id,
			input: input.choice,
			signal,
		});
		if (error !== null) {
			await holdLeave(abandonRecording(client, id));
			return Err({ message: error.message, capture: error });
		}
		return Ok({ id, capture: data });
	}

	/**
	 * Stop: release the microphone and complete the recording's note. A Stop
	 * pressed again joins the first until it has finished. Once closed,
	 * nothing more is done here: what was written stays, and the next start
	 * completes it.
	 */
	function finishRecording(): Promise<void> {
		const current = captureState;
		if (current.phase !== 'recording' || disposed)
			return finishing ?? Promise.resolve();
		captureState = { ...current, phase: 'stopping' };
		const finished = finish(current);
		finishing = finished;
		const forget = () => {
			if (finishing === finished) finishing = undefined;
		};
		finished.then(forget, forget);
		return finished;
	}

	async function finish({
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
		// What was written stays either way, and a length not written now is
		// written from the audio on the next start. A recording that wrote no
		// audio at all (the store refused it, or nothing was captured) takes
		// its note with it.
		if (error !== null) {
			recorderError = error.message;
			await holdLeave(abandonRecording(client, take.id));
			return;
		}
		const completed = await holdLeave(
			completeRecording(client, take.id, stopped.durationMs),
		);
		if (completed.error !== null && !disposed) recorderError = completed.error;
	}

	/**
	 * Repair the audio a quit, a crash, or a closed tab cut off, then write
	 * each such recording's length into its note. Nothing records here yet,
	 * and a recording another tab is still writing is left alone. What cannot
	 * be completed is said and left for the next start; it never stops
	 * Whispering from starting.
	 */
	async function completeCutOffRecordings() {
		const finished = await holdLeave(
			finishCutOffRecordings(client, services.capture.recover),
		);
		if (finished.error !== null && !disposed)
			recorderError = `Recordings a quit or a crash cut off could not be completed: ${finished.error}`;
	}

	async function saveConnection(
		operation: Operation,
		change: ConnectionChange,
	) {
		const why = refused();
		if (why !== undefined) return why;
		try {
			const { data: saved, error } = await services.connections.set(
				operation,
				change,
			);
			if (error !== null) return error;
			if (!disposed) {
				connections = saved;
				connectionsError = undefined;
			}
			return undefined;
		} catch (cause) {
			return describe(cause);
		}
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

	const settings = createSettingsDraft(
		services.connections.defaults,
		() => connections,
		saveConnection,
	);

	return {
		services,
		settings,
		/** Whether the sidebar is open on a wide window. */
		get sidebarOpen() {
			return sidebarOpen;
		},
		set sidebarOpen(open: boolean) {
			sidebarOpen = open;
		},
		/** What this device has set up for requests, never a key. */
		get connections() {
			return connections;
		},
		get connectionsProblem() {
			return connectionsError;
		},
		/**
		 * Whether a recipe can run now, and with what: the one decision the Run
		 * button, the post-processing choice, a transcript's menu, and the run
		 * itself all use. Undefined is a recipe whose note does not read.
		 */
		resolve,
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
		 * Read the connections and the saved microphone choice, and complete
		 * the recordings a quit, a crash, or a closed tab cut off.
		 */
		start(): Promise<void> {
			starting ??= (async () => {
				try {
					if (disposed) throw new Error(STOPPED);
					await readConnections();
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
		 * Start a recording from the chosen microphone: its note is made first,
		 * and its audio is written into the files as it records.
		 */
		async startRecording() {
			if (captureState.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			const attempt = new AbortController();
			captureState = { phase: 'starting', attempt };
			input.release();
			const at = new Date();
			const started = await startTake(at, attempt.signal);
			// Closed while the microphone was opening: an aborted opener releases it.
			if (attempt.signal.aborted || disposed) {
				captureState = { phase: 'idle' };
				return;
			}
			if (started.error !== null) {
				captureState = { phase: 'idle' };
				recorderError = started.error.message;
				if (started.error.capture)
					input.noteRecordingError(started.error.capture);
				return;
			}
			const take = started.data;
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
		/** Stop: the microphone is released and the recording's note completed. */
		stopRecording: finishRecording,

		// ------------------------------------------------------------------
		// Connections
		// ------------------------------------------------------------------

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to Whispering's files.
		 */
		saveConnection,
		/** Read the connections again, as after a failed read. */
		readConnections,
	};
}

export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
