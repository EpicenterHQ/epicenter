/**
 * Whispering for one mounted page: the services, the connections, the
 * microphone, and the recorder. What the files show is the library's
 * (`library.svelte.ts`); both write through the same client, which the
 * variant root chose (`$lib/device.ts` in the web build).
 *
 * A recording is kept when it stops, as two writes through the client: its
 * audio first, then its note, so a note never names audio that is not
 * there. Recording never waits on the network, and nothing kept here ever
 * moves (ADR-0700). One the client cannot keep (a private window, a full
 * disk) stays in this page, to save again or download, until the page
 * closes.
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
import type { ActiveCapture } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import type { Whispering as WhisperingContract } from './contract.js';
import type { NewRecording } from './files.svelte.js';
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

/** A finished recording the client could not keep, held in this page. */
export type UnsavedRecording = NewRecording & {
	/** Why it was not kept. */
	readonly reason: string;
	/** An object URL of its audio, to download it. */
	readonly download: string;
};

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
	const services = createServices();
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

	type CaptureState =
		| { phase: 'idle' }
		| { phase: 'starting'; attempt: AbortController }
		| { phase: 'recording'; at: Date; capture: ActiveCapture }
		| { phase: 'stopping'; at: Date; capture: ActiveCapture };
	let captureState = $state.raw<CaptureState>({ phase: 'idle' });
	/**
	 * The last Stop until it has finished, the recording kept included,
	 * though the microphone is free sooner. A Stop pressed again joins it.
	 */
	let finishing: Promise<void> | undefined;
	let recorderError = $state<string | undefined>();
	/** Finished recordings the client could not keep, newest last. */
	let unsaved = $state.raw<UnsavedRecording[]>([]);

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => captureState.phase !== 'idle',
	});

	// --- recording ----------------------------------------------------------

	/**
	 * Keep a finished recording: its audio, then its note, so the note never
	 * names audio that is not there. Run again with the same recording after
	 * a failure, it finishes what was kept: a file already at the
	 * recording's path is this recording's own (its id is new), so
	 * `Occupied` counts as kept.
	 */
	async function saveRecording(
		recording: NewRecording,
	): Promise<Result<void, string>> {
		const { id, ext, bytes, ...note } = recording;
		async function write(): Promise<Result<void, string>> {
			const audio = await client.audio.create({ id, ext, bytes });
			if (audio.error && audio.error.name !== 'Occupied')
				return Err(audio.error.message);
			const written = await client.recordings.create({ id, ...note });
			if (written.error && written.error.name !== 'Occupied')
				return Err(written.error.message);
			return Ok(undefined);
		}
		return holdLeave(write());
	}

	/**
	 * Keep `recording`; one that cannot be kept is held in this page with
	 * why. Answers whether it was kept.
	 */
	async function keepRecording(recording: NewRecording): Promise<boolean> {
		const saved = await saveRecording(recording);
		const held = unsaved.find(({ id }) => id === recording.id);
		if (saved.error === null) {
			if (held) URL.revokeObjectURL(held.download);
			unsaved = unsaved.filter(({ id }) => id !== recording.id);
			return true;
		}
		const download =
			held?.download ??
			URL.createObjectURL(
				new Blob([recording.bytes as Uint8Array<ArrayBuffer>]),
			);
		unsaved = [
			...unsaved.filter(({ id }) => id !== recording.id),
			{ ...recording, reason: saved.error, download },
		];
		return false;
	}

	/**
	 * Stop: release the microphone and keep the recording. A Stop pressed
	 * again joins the first until it has finished. Once closed, nothing is
	 * kept here: leaving the page ends the capture.
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
		at,
		capture,
	}: Extract<CaptureState, { phase: 'recording' }>) {
		const { data: audio, error } = await capture
			.stop()
			.catch((cause) => ({ data: null, error: { message: describe(cause) } }));
		captureState = { phase: 'idle' };
		if (disposed) return;
		if (error !== null) {
			recorderError = error.message;
			return;
		}
		await keepRecording({
			id: timeId(at),
			title: defaultTitle(at),
			recordedAt: at.toISOString(),
			durationMs: audio.durationMs,
			capture: services.capture.source,
			ext: audio.ext,
			bytes: audio.bytes,
		});
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
		for (const { download } of unsaved) URL.revokeObjectURL(download);
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
		/** Read the connections and the saved microphone choice. */
		start(): Promise<void> {
			starting ??= (async () => {
				try {
					if (disposed) throw new Error(STOPPED);
					await readConnections();
					// The saved choice only: no microphone is opened or listed at launch.
					if (disposed) throw new Error(STOPPED);
					await input.load();
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
				? { phase: 'recording', startedAt: captureState.capture.startedAt }
				: { phase: captureState.phase };
		},
		get recorderError() {
			return recorderError;
		},
		/** Finished recordings the client could not keep, held in this page. */
		get unsavedRecordings() {
			return unsaved;
		},
		/** Try to keep an unsaved recording again. Answers why it was not, if it was not. */
		async saveRecordingAgain(id: string): Promise<string | undefined> {
			const held = unsaved.find((item) => item.id === id);
			if (held === undefined || refused() !== undefined) return refused();
			const { reason: _, download: __, ...recording } = held;
			const kept = await keepRecording(recording);
			return kept ? undefined : unsaved.find((item) => item.id === id)?.reason;
		},
		/** Let go of an unsaved recording: its audio is gone with it. */
		discardRecording(id: string) {
			const held = unsaved.find((item) => item.id === id);
			if (held) URL.revokeObjectURL(held.download);
			unsaved = unsaved.filter((item) => item.id !== id);
		},
		/** Start a recording from the chosen microphone. Nothing is kept until it stops. */
		async startRecording() {
			if (captureState.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			const attempt = new AbortController();
			captureState = { phase: 'starting', attempt };
			input.release();
			const at = new Date();
			const { data: capture, error: startError } = await services.capture.start(
				{ input: input.choice, signal: attempt.signal },
			);
			// Closed while the microphone was opening: an aborted opener releases it.
			if (attempt.signal.aborted || disposed) {
				captureState = { phase: 'idle' };
				return;
			}
			if (startError !== null) {
				captureState = { phase: 'idle' };
				recorderError = startError.message;
				input.noteRecordingError(startError);
				return;
			}
			captureState = { phase: 'recording', at, capture };
			capture.onEnded((reason) => {
				if (
					captureState.phase !== 'recording' ||
					captureState.capture !== capture
				)
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
		/** Stop: the microphone is released and the recording kept. */
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
