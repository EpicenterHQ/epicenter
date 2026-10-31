/**
 * One of Whispering's two views (decision 76) over its own files
 * (`files.svelte.ts`): "On this device" over this browser's, or "Synced"
 * over the person's repository. Never both: a note uploading leaves this
 * device's view and appears in the repository's, and nothing here follows
 * it across.
 *
 * Every list here is derived from what the view's files show, read
 * reactively. Notes that read are listed to edit; the rest are named, with
 * why and their text, for repair. Nothing here holds text ahead of the
 * files: what a person types is an edit in the component that shows it, and
 * each write answers once it landed. The caller of a write presents a
 * failure. A transcription or recipe run lives in this window until its
 * answer arrives, and its result is created then, in this view's files
 * (`runs.svelte.ts`).
 *
 * A view's library is made when its pages open and let go when they close.
 * Leaving it waits for nothing and refuses nothing: a run under way still
 * keeps its answer in its view's files, unless Whispering itself is closing.
 */
import type { Version } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Err, type Result } from 'wellcrafted/result';
import {
	captureDeletion,
	type Deletion,
	describeIssues,
	type NoteRef,
	runDeletion,
} from './deletion.js';
import {
	byTitle,
	type InvalidNote,
	type NoteName,
	newest,
	type WhisperingFiles,
} from './files.svelte.js';
import type { PostProcessingChoice } from './post-processing.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createRuns } from './runs.svelte.js';
import type { Whispering } from './whispering.svelte.js';

export type { Deletion, NoteRef } from './deletion.js';
export type {
	AudioFile,
	RecordingAudio,
	RecordingNote,
	TextRunNote,
	TranscriptionNote,
	TransformationNote,
	TransformationRunNote,
	View,
} from './files.svelte.js';
export type { Run, RunState } from './runs.svelte.js';

/** A note that does not read, for the person to repair as text or delete. */
export type Repair = InvalidNote<NoteName> & {
	readonly collection: NoteName;
	/** Why it does not read, in a line. */
	readonly reason: string;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

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

export function createLibrary({
	whispering,
	files,
}: {
	/** What both views share: the connections, and whether Whispering is closing. */
	whispering: Whispering;
	/** This view's files. */
	files: WhisperingFiles;
}) {
	const { refused } = whispering;
	/** What this view's pages show. Held here so no page owns it. */
	const ui = $state({
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
		 * Text pasted to try a transformation on. It stays when the person
		 * moves between this view's pages or transformations. It is never
		 * written anywhere; a run takes a copy of it when it starts.
		 */
		pastedText: '',
		/**
		 * The transformation chosen for post-processing, by id. Undefined is
		 * None, which is how a view starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});

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

	let selectedId = $state<string | undefined>();
	let selectedTransformationId = $state<string | undefined>();
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new SvelteSet<string>();

	// Recordings that are gone are no longer selected in the table.
	const stopPruning = $effect.root(() => {
		$effect(() => {
			if (files.recordings.loading) return;
			const present = new Set(entries.map((note) => note.id));
			if (ui.recordingSelected.some((id) => !present.has(id)))
				ui.recordingSelected = ui.recordingSelected.filter((id) =>
					present.has(id),
				);
		});
	});

	const runs = createRuns({
		files,
		transcribe: (request) => whispering.services.transcribe(request),
		transform: (request) => whispering.services.transform(request),
		refused,
		connections: () => ({
			info: whispering.connections,
			error: whispering.connectionsProblem,
		}),
		resolve: whispering.resolve,
		deleting,
	});

	/** Show recording `id` beside the recordings. Opening never waits or asks. */
	function openRecording(id: string): boolean {
		if (whispering.closing) return false;
		selectedId = id;
		return true;
	}

	/** Show transformation `id` on its page. */
	function openTransformation(id: string): boolean {
		if (whispering.closing) return false;
		selectedTransformationId = id;
		return true;
	}

	/** After a delete, the view state lets the note go. */
	function deleted({ collection, id }: NoteRef) {
		if (collection === 'recordings' && selectedId === id)
			selectedId = undefined;
		if (collection === 'transformations' && selectedTransformationId === id)
			selectedTransformationId = undefined;
		if (collection === 'transformations' && ui.postProcessing === id)
			ui.postProcessing = undefined;
	}

	const deletionContext = () => ({
		files,
		busy: (id: string) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
	});

	return {
		/** Which view this is: this device's files, or the repository's. */
		view: files.view,
		/** The lists the components edit through (`fieldEdit`), one per note collection. */
		files,
		ui,
		/** Why this view's recordings or audio could not be listed (no private storage, or offline). */
		get error() {
			return files.recordings.error ?? null;
		},
		/** Whether Whispering is closing, so nothing new starts. */
		get closing() {
			return whispering.closing;
		},
		/** The selected transformation, resolved against the lists and the connection. */
		get postProcessing(): PostProcessingChoice {
			const id = ui.postProcessing;
			if (id === undefined) return { kind: 'none' };
			const entry = transformations.find((item) => item.id === id);
			if (entry === undefined) return { kind: 'missing', id };
			const resolved = whispering.resolve(entry);
			return resolved.kind === 'ready'
				? { kind: 'ready', entry }
				: { kind: 'repair', entry, reason: resolved.reason };
		},
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
		/** Recording `id`'s audio bytes. */
		readAudio: files.readAudio,

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
			openTransformation(id);
			return undefined;
		},

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
					{ files, dropFailed: runs.dropFailed, deleted },
					deletion,
				).catch((cause: unknown) => describe(cause));
			} finally {
				if (recording !== undefined) deleting.delete(recording);
			}
		},
		/** Stop following the lists. Runs under way still keep their answers. */
		dispose() {
			stopPruning();
			files.dispose();
		},
	};
}

export type Library = ReturnType<typeof createLibrary>;
/** The view a page shows: set by its view's layout (`WhisperingView`). */
export const [getLibrary, setLibrary] = createContext<Library>();
