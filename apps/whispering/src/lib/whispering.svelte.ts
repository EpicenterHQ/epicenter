/**
 * Whispering for one mounted page and account: the services, the
 * connections, the microphone, and the recorder. What the files show is
 * each view's own (`library.svelte.ts`); this is what both views share.
 *
 * In a browser, a recording is kept when it stops: its audio and its note,
 * on this device, as one capture (`saveCapture`), signed in or not, so
 * recording never waits on the network. It shows under "On this device";
 * signed in, the uploader moves it to the repository, and it shows under
 * "Synced". One the device cannot keep (a private window, a full disk) stays
 * in this page, to save again or download, until the page closes.
 *
 * On the desktop the shell writes the audio into the folder from the first
 * sample, so the recording's note is made when it starts and completed with
 * its length when it stops (`folder-recordings.ts`); a launch first
 * completes what a quit or a crash cut off.
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Client } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { saveCapture } from '@epicenter/folder/browser';
import { holdLeave } from '@epicenter/svelte/leave-guard';
import { createContext } from 'svelte';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createServices } from '#platform/services';
import type { ActiveCapture, CaptureError, FolderCapture } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import type { Whispering as WhisperingContract } from './contract.js';
import type { NewRecording } from './files.svelte.js';
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

/** A finished recording this device could not keep, held in this page. */
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
	device,
}: {
	/** This browser's files, where every recording is kept first. */
	device: Client<WhisperingContract>;
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

	/** A capture under way: one the page holds, or one the shell writes into the folder. */
	type Take =
		| { keeps: 'page'; capture: ActiveCapture }
		| { keeps: 'folder'; id: string; capture: FolderCapture };
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
	/** Finished recordings this device could not keep, newest last. */
	let unsaved = $state.raw<UnsavedRecording[]>([]);

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => captureState.phase !== 'idle',
	});

	// --- recording ----------------------------------------------------------

	/**
	 * Open the microphone for a recording made at `at`. On the desktop its
	 * note is made first, and removed again when the microphone does not
	 * open.
	 */
	async function startTake(
		at: Date,
		signal: AbortSignal,
	): Promise<Result<Take, { message: string; capture?: CaptureError }>> {
		const capture = services.capture;
		if (capture.keeps !== 'folder') {
			const { data, error } = await capture.start({
				input: input.choice,
				signal,
			});
			return error === null
				? Ok({ keeps: 'page', capture: data })
				: Err({ message: error.message, capture: error });
		}
		const id = timeId(at);
		const made = await holdLeave(
			beginRecording(device, {
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
			await holdLeave(abandonRecording(device, id));
			return Err({ message: error.message, capture: error });
		}
		return Ok({ keeps: 'folder', id, capture: data });
	}

	/**
	 * Keep a finished recording on this device: its audio, then its note, as
	 * one capture that uploads once someone is signed in. Run again with the
	 * same recording after a failure, it finishes what was kept.
	 */
	async function saveRecording(
		recording: NewRecording,
	): Promise<Result<void, string>> {
		const { id, ext, bytes, ...note } = recording;
		const saved = await holdLeave(
			saveCapture(device, {
				id,
				files: [
					{ collection: 'audio', value: { id, ext, bytes } },
					{ collection: 'recordings', value: { id, ...note } },
				],
			}),
		);
		return saved.error === null ? Ok(undefined) : Err(saved.error.message);
	}

	/**
	 * Keep `recording` on this device; one that cannot be kept is held in this
	 * page with why. Answers whether it was kept.
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
		take,
	}: Extract<CaptureState, { phase: 'recording' }>) {
		if (take.keeps === 'folder') {
			const { data: stopped, error } = await take.capture
				.stop()
				.catch((cause) => ({
					data: null,
					error: { message: describe(cause) },
				}));
			captureState = { phase: 'idle' };
			if (disposed) return;
			// The audio stays in the folder either way; a length not written now
			// is written from the audio on the next launch.
			if (error !== null) {
				recorderError = error.message;
				return;
			}
			const completed = await holdLeave(
				completeRecording(device, take.id, stopped.durationMs),
			);
			if (completed.error !== null && !disposed)
				recorderError = completed.error;
			return;
		}
		const { data: audio, error } = await take.capture
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

	/**
	 * On the desktop: repair the audio a quit or a crash cut off, then write
	 * each such recording's length into its note. Nothing records yet, so no
	 * file here is still being written. What cannot be completed is said and
	 * left for the next launch; it never stops Whispering from starting.
	 */
	async function completeCutOffRecordings() {
		const capture = services.capture;
		if (capture.keeps !== 'folder') return;
		const repaired = await capture.recover();
		const finished = await holdLeave(
			finishCutOffRecordings(device, capture.ext),
		);
		const problem = repaired.error?.message ?? finished.error ?? undefined;
		if (problem !== undefined && !disposed)
			recorderError = `Recordings a quit or a crash cut off could not be completed: ${problem}`;
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
		/** The client every recording is kept in: this browser's files, or the desktop app's folder. */
		device,
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
		 * Read the connections and the saved microphone choice, and on the
		 * desktop complete the recordings a quit or a crash cut off.
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
		/** Finished recordings this device could not keep, held in this page. */
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
		/**
		 * Start a recording from the chosen microphone. In a browser nothing is
		 * kept until it stops; on the desktop its note is made first and its
		 * audio is in the folder from the first sample.
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
		/** Stop: the microphone is released and the recording kept on this device. */
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
