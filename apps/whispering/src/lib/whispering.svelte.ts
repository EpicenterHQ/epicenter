/**
 * The mounted Whispering app state over its files (`files.svelte.ts`): this
 * browser's notes and, signed in, each `oneList` over them and the person's
 * repository's, composed here; and a recording's audio on either side.
 *
 * Every list here is derived from what the files show, read reactively.
 * Notes that read are listed to edit; the rest are named, with why and their
 * text, for repair. Nothing here holds text ahead of the files: what a
 * person types is an edit in the view that shows it, and each write answers
 * once it landed. The caller of a write presents a failure.
 *
 * A recording is kept when it stops: its audio and its note, on this device,
 * as one capture that uploads once someone is signed in. One the device
 * cannot keep (a private window, a full disk) stays in this page, to save
 * again or download, until the page closes. A transcription or recipe run
 * lives in this window until its answer arrives, and its result is kept then
 * (`runs.svelte.ts`).
 *
 * Closing waits for nothing here: `dispose` refuses new work and late
 * answers and returns. A recording under way ends with the page.
 */
import type { Client, Version } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { fromClient, oneList } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Err, type Result } from 'wellcrafted/result';
import { createServices } from '#platform/services';
import type { ActiveCapture } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import type { Whispering as WhisperingContract } from './contract.js';
import {
	captureDeletion,
	type Deletion,
	describeIssues,
	type NoteRef,
	runDeletion,
} from './deletion.js';
import {
	byTitle,
	createAudio,
	type InvalidNote,
	type NewRecording,
	type NoteLists,
	type NoteName,
	newest,
	type WhisperingFiles,
} from './files.svelte.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { PostProcessingChoice } from './post-processing.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createRuns } from './runs.svelte.js';
import { createSettingsDraft } from './settings-draft.svelte.js';

export const STOPPED = 'Whispering stopped before it finished starting.';

export type { Deletion, NoteRef } from './deletion.js';
export type {
	AudioFile,
	RecordingAudio,
	RecordingNote,
	TextRunNote,
	TranscriptionNote,
	TransformationNote,
	TransformationRunNote,
} from './files.svelte.js';
export type { Run, RunState } from './runs.svelte.js';

/** A note that does not read, for the person to repair as text or delete. */
export type Repair = InvalidNote<NoteName> & {
	readonly collection: NoteName;
	/** Why it does not read, in a line. */
	readonly reason: string;
};

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

const repairsOf = <TName extends NoteName>(
	collection: TName,
	invalid: readonly InvalidNote<TName>[],
): Repair[] =>
	invalid.map((note) => ({
		...(note as InvalidNote<NoteName>),
		collection,
		reason: describeIssues(note.issues),
	}));

/** Newest first. */
const byNewest = <T extends { readonly createdAt: string }>(
	list: readonly T[],
): T[] => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function createWhispering({
	device,
	repository,
}: {
	/** This browser's files. */
	device: Client<WhisperingContract>;
	/** The person's repository, signed in; null signed out. */
	repository: Client<WhisperingContract> | null;
}) {
	const services = createServices();
	const here = fromClient(device);
	const there = repository === null ? null : fromClient(repository);
	const lists: NoteLists =
		there === null
			? here
			: {
					recordings: oneList(here.recordings, there.recordings),
					transcriptions: oneList(here.transcriptions, there.transcriptions),
					transformations: oneList(here.transformations, there.transformations),
					transformation_runs: oneList(
						here.transformation_runs,
						there.transformation_runs,
					),
					text_runs: oneList(here.text_runs, there.text_runs),
				};
	const files: WhisperingFiles = {
		...lists,
		...createAudio({ device, repository }),
	};
	/** What the shell shows. Held here so no route owns it. */
	const view = $state({
		sidebarOpen: false,
		/** The recordings search. Notes needing repair are never searched out. */
		recordingQuery: '',
		/** The order of the recordings table. */
		recordingSort: DEFAULT_SORT as RecordingSort,
		/**
		 * The recordings selected in the table, by id. A listing removes ids
		 * that are gone; search keeps hidden selections.
		 */
		recordingSelected: [] as string[],
		/**
		 * An action on several recordings that is under way: how far it has got.
		 * Held here so a page change neither hides it nor lets a second start.
		 */
		recordingBulk: undefined as
			| {
					readonly label: string;
					readonly done: number;
					readonly total: number;
			  }
			| undefined,
		/**
		 * Whether a recording's details are showing: beside the table on a wide
		 * window, in place of it on a narrow one. Closing them changes nothing
		 * else: the recording stays selected.
		 */
		showingDetail: false,
		/** On a narrow window, whether a transformation's editor shows in place of the list. */
		showingTransformation: false,
		/** The transcription a transformation is tried on, by id. */
		applyTo: undefined as string | undefined,
		/** What a transformation's page runs on: a saved transcript, or pasted text. */
		applySource: 'transcript' as 'transcript' | 'pasted',
		/**
		 * Text pasted to try a transformation on. One text for the mounted app, so
		 * it stays when the person moves between pages or transformations. It
		 * is never written anywhere; a run takes a copy of it when it starts.
		 */
		pastedText: '',
		/**
		 * The transformation chosen for post-processing, by id. Undefined is
		 * None, which is how the app starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});
	let starting: Promise<void> | undefined;

	/** Product cleanup also fences new work and late replies. */
	let disposed = false;
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- reads -----------------------------------------------------------------

	const entries = $derived(
		files.recordings.items.toSorted(newest((note) => note.recordedAt)),
	);
	const transformations = $derived(
		files.transformations.items.toSorted(byTitle),
	);
	const transcriptions = $derived(
		files.transcriptions.items.toSorted(newest((note) => note.createdAt)),
	);
	const transformationRuns = $derived(
		files.transformation_runs.items.toSorted(newest((note) => note.createdAt)),
	);
	const textRuns = $derived(
		files.text_runs.items.toSorted(newest((note) => note.createdAt)),
	);
	const transcriptsByRecording = $derived.by(() => {
		const byRecording = new Map<string, (typeof transcriptions)[number][]>();
		for (const note of transcriptions)
			byRecording.set(note.recordingId, [
				...(byRecording.get(note.recordingId) ?? []),
				note,
			]);
		return byRecording;
	});
	const repairs = $derived([
		...repairsOf('recordings', files.recordings.invalid),
		...repairsOf('transcriptions', files.transcriptions.invalid),
		...repairsOf('transformation_runs', files.transformation_runs.invalid),
	]);

	/** Notes still on this device, not uploaded yet (a recording counts once, by its note). */
	const waiting = $derived(
		[
			files.recordings,
			files.transcriptions,
			files.transformations,
			files.transformation_runs,
			files.text_runs,
		].reduce(
			(count, list) =>
				count +
				[...list.items, ...list.invalid].filter(
					({ id }) => list.where?.({ id }) === 'device',
				).length,
			0,
		),
	);

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

	let selectedId = $state<string | undefined>();
	let selectedTransformationId = $state<string | undefined>();

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
	/** Finished recordings this device could not keep, newest last. */
	let unsaved = $state.raw<UnsavedRecording[]>([]);
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new SvelteSet<string>();

	// Recordings that are gone are no longer selected in the table.
	const stopPruning = $effect.root(() => {
		$effect(() => {
			if (files.recordings.loading) return;
			const present = new Set(entries.map((note) => note.id));
			if (view.recordingSelected.some((id) => !present.has(id)))
				view.recordingSelected = view.recordingSelected.filter((id) =>
					present.has(id),
				);
		});
	});

	const runs = createRuns({
		files,
		transcribe: (request) => services.transcribe(request),
		transform: (request) => services.transform(request),
		refused,
		connections: () => ({ info: connections, error: connectionsError }),
		resolve,
		deleting,
	});

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => captureState.phase !== 'idle',
	});

	/** Show recording `id` beside the recordings. Opening never waits or asks. */
	function openRecording(id: string): boolean {
		if (disposed) return false;
		selectedId = id;
		return true;
	}

	/** Show transformation `id` on its page. */
	function openTransformation(id: string): boolean {
		if (disposed) return false;
		selectedTransformationId = id;
		return true;
	}

	/** After a delete, the view state lets the note go. */
	function deleted({ collection, id }: NoteRef) {
		if (collection === 'recordings' && selectedId === id)
			selectedId = undefined;
		if (collection === 'transformations' && selectedTransformationId === id)
			selectedTransformationId = undefined;
		if (collection === 'transformations' && view.postProcessing === id)
			view.postProcessing = undefined;
	}

	// --- recording ----------------------------------------------------------

	/**
	 * Keep `recording` on this device; one that cannot be kept is held in this
	 * page with why. Answers whether it was kept.
	 */
	async function keepRecording(recording: NewRecording): Promise<boolean> {
		const saved = await files.saveRecording(recording);
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
		const selectionBefore = selectedId;
		const { data: audio, error } = await capture
			.stop()
			.catch((cause) => ({ data: null, error: { message: describe(cause) } }));
		captureState = { phase: 'idle' };
		if (disposed) return;
		if (error !== null) {
			recorderError = error.message;
			return;
		}
		const id = timeId(at);
		const kept = await keepRecording({
			id,
			title: defaultTitle(at),
			recordedAt: at.toISOString(),
			durationMs: audio.durationMs,
			capture: services.capture.source,
			ext: audio.ext,
			bytes: audio.bytes,
		});
		if (kept && !disposed && selectedId === selectionBefore) openRecording(id);
	}

	const deletionContext = () => ({
		files,
		busy: (id: string) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
	});

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
		stopPruning();
		files.dispose();
	}

	const settings = createSettingsDraft(
		services.connections.defaults,
		() => connections,
		saveConnection,
	);

	return {
		services,
		/** The lists the views edit through (`fieldEdit`), one per note collection. */
		files,
		view,
		settings,
		/** Whether someone is signed in, so the repository is open beside this browser's files. */
		get signedIn() {
			return there !== null;
		},
		/** Why the repository could not be listed (offline, or refused); null when it can be, or signed out. */
		get repositoryError() {
			return there?.recordings.error ?? there?.audio.error ?? null;
		},
		/** Why this device's files could not be listed (no private storage, as in a private window). */
		get deviceError() {
			return here.recordings.error ?? here.audio.error ?? null;
		},
		/** Notes still on this device, not uploaded yet. */
		get waiting() {
			return waiting;
		},
		/** Which side the copy shown of the note `id` of `collection` is on. */
		whereOf(collection: NoteName, id: string) {
			// Signed out, every note is on this device.
			return files[collection].where?.({ id }) ?? 'device';
		},
		/** Whether the note `id` of `collection` is still on this device while signed in: not uploaded yet. */
		notUploaded(collection: NoteName, id: string) {
			return there !== null && files[collection].where?.({ id }) === 'device';
		},
		/** The selected transformation, resolved against the lists and the connection. */
		get postProcessing(): PostProcessingChoice {
			const id = view.postProcessing;
			if (id === undefined) return { kind: 'none' };
			const entry = transformations.find((item) => item.id === id);
			if (entry === undefined) return { kind: 'missing', id };
			const resolved = resolve(entry);
			return resolved.kind === 'ready'
				? { kind: 'ready', entry }
				: { kind: 'repair', entry, reason: resolved.reason };
		},
		/** The microphone the next recording uses, and the test of it. */
		input,
		/** Recordings that read, newest first. */
		get entries() {
			return entries;
		},
		/** Whether the recordings have not been listed yet. */
		get listing() {
			return files.recordings.loading;
		},
		/** Recordings, transcripts and their results that do not read, with why. */
		get repairs() {
			return repairs;
		},
		get transcriptions() {
			return transcriptions;
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

		// ------------------------------------------------------------------
		// Selection
		// ------------------------------------------------------------------

		get selectedId() {
			return selectedId;
		},
		/** What the recordings page shows until selection changes, including a recording that went. */
		get selection() {
			const id = selectedId;
			if (id === undefined) return undefined;
			return {
				id,
				note: entries.find((note) => note.id === id),
				repair: repairs.find(
					(note) => note.collection === 'recordings' && note.id === id,
				),
			};
		},
		get selectedTransformationId() {
			return selectedTransformationId;
		},
		/** The transformation being edited, with its listed note when it reads. */
		get selectedTransformation() {
			const id = selectedTransformationId;
			if (id === undefined) return undefined;
			return {
				id,
				note: transformations.find((note) => note.id === id),
				repair: files.transformations.invalid.find((note) => note.id === id),
			};
		},
		openRecording,
		openTransformation,

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		get closing() {
			return disposed;
		},

		// ------------------------------------------------------------------
		// Starting
		// ------------------------------------------------------------------

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

		// ------------------------------------------------------------------
		// Lists
		// ------------------------------------------------------------------

		/** Transcripts of one recording, newest first. */
		resultsFor(id: string) {
			return transcriptsByRecording.get(id) ?? [];
		},
		/** Transformations that read, by title. */
		get transformations() {
			return transformations;
		},
		/** Transformation notes that do not read, with why. */
		get transformationRepairs(): Repair[] {
			return repairsOf('transformations', files.transformations.invalid);
		},
		/** Results made from one transcript, newest first. */
		outputsFor(transcriptionId: string) {
			return byNewest(
				transformationRuns.filter(
					(note) => note.transcriptionId === transcriptionId,
				),
			);
		},
		/** Results one transformation made from transcripts, newest first. They outlive it. */
		outputsOf(transformationId: string) {
			return byNewest(
				transformationRuns.filter(
					(note) => note.transformationId === transformationId,
				),
			);
		},
		/** Results on pasted text one transformation made, newest first. */
		textOutputsOf(transformationId: string) {
			return byNewest(
				textRuns.filter((note) => note.transformationId === transformationId),
			);
		},
		/** Notes in `text_runs/` that do not read as results. */
		get textRepairs(): Repair[] {
			return repairsOf('text_runs', files.text_runs.invalid);
		},
		/** Where recording `id`'s audio is, read reactively. */
		audioOf: files.audioOf,
		/** Recording `id`'s audio bytes, from the nearest copy. */
		readAudio: files.readAudio,

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
		// Requests and their results
		// ------------------------------------------------------------------

		transcriptionRun: runs.transcriptionRun,
		runsOn: runs.runsOn,
		textRun: runs.textRun,
		get recipeRuns() {
			return runs.recipeRuns;
		},
		/** Answers that arrived and whose note could not be created; each is saved again when asked. */
		get unwrittenAnswers() {
			return runs.unwritten;
		},
		transcribe: runs.transcribe,
		transform: runs.transform,
		transformText: runs.transformText,
		runAgain: runs.runAgain,
		saveAgain: runs.saveAgain,
		dismissRun: runs.dismiss,

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		/**
		 * A new recipe: a title and instructions. It names no model of its own
		 * (`null`), so it runs with the text connection.
		 */
		async createTransformation({
			title,
			prompt,
		}: {
			title: string;
			prompt: string;
		}): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const id = timeId();
			const { error } = await files.transformations.create({
				id,
				title,
				model: null,
				body: prompt,
			});
			if (error !== null) return error.message;
			if (!disposed) openTransformation(id);
			return undefined;
		},

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to Whispering's files.
		 */
		saveConnection,
		/** Read the connections again, as after a failed read. */
		readConnections,

		/**
		 * Replace note `ref` with `text`, as a repair, over `over` (by default
		 * the version shown): it must read as one, and it is written in house
		 * style.
		 */
		replace(ref: NoteRef, text: string, options?: { over?: Version }) {
			const why = refused();
			if (why !== undefined)
				return Promise.resolve(Err({ name: 'Closing', message: why }));
			return files[ref.collection].replace({ id: ref.id }, text, options);
		},

		/**
		 * Capture what deleting `ref` would remove, for the person to confirm,
		 * from what the lists show. Capturing changes nothing.
		 */
		deletionFor(ref: NoteRef): Result<Deletion, string> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion(deletionContext(), ref);
		},
		/**
		 * Delete what was confirmed. A recording is kept if new results
		 * appeared after confirmation.
		 */
		async delete(deletion: Deletion): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const recording =
				deletion.kind === 'recording'
					? deletion.id
					: deletion.kind === 'invalid' &&
							deletion.note.collection === 'recordings'
						? deletion.note.id
						: undefined;
			const busy = recording && deletionContext().busy(recording);
			if (busy) return busy;
			if (recording !== undefined) deleting.add(recording);
			try {
				return await runDeletion(
					{
						files,
						dropFailed: runs.dropFailed,
						deleted: (note) => {
							if (!disposed) deleted(note);
						},
					},
					deletion,
				).catch((cause: unknown) => describe(cause));
			} finally {
				if (recording !== undefined) deleting.delete(recording);
			}
		},
		/**
		 * Stop new work and late answers, release the microphone this page
		 * opened for a test, and stop following the lists; waits for nothing. A
		 * recording opening now is released when it answers; one under way
		 * ends with the page.
		 */
		dispose,
	};
}

export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
