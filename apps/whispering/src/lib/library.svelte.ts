/**
 * Whispering's library: what the pages list, edit, run and delete, over the
 * folder query (`folder-query.ts`). The folder is the one `app.ts` opened
 * over the `Files` the build chose; nothing here knows which.
 *
 * Every list here is derived from the folder query's answer. Notes that
 * read are listed to edit; the rest are named, with why and their text, for
 * repair. A recording's audio with no note lists as an untitled recording.
 * Nothing here holds text ahead of the folder: what a person types is an
 * editor's (`note-editor.svelte.ts`), an answer not yet saved is its run's
 * (`runs.svelte.ts`), and a write that fails says why.
 *
 * The library is made when the app's pages open and let go when they
 * close. Leaving waits for nothing and refuses nothing: a run under way
 * still keeps its answer in the files, unless Whispering itself is closing.
 */

import { createQuery } from '@tanstack/svelte-query';
import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Err, type Result } from 'wellcrafted/result';
import {
	captureDeletion,
	type Deletion,
	deletedNote,
	recordingDeleted,
	runDeletion,
} from './deletion.js';
import {
	type AudioBytes,
	audioOf,
	audioSizeOf,
	byTitle,
	describeIssues,
	EMPTY_FOLDER,
	type FolderSnapshot,
	type InvalidNote,
	type NoteName,
	type NoteRef,
	newest,
	unnotedOf,
} from './folder.js';
import type { FolderQuery } from './folder-query.js';
import type { NOTES } from './format/folder.js';
import { timeId } from './format/ids.js';
import { editNote, type NoteEditor } from './note-editor.svelte.js';
import type { NotePatch } from './notes.js';
import type { PostProcessingChoice } from './post-processing.js';
import type { RecipeRow, ResolvedRecipe } from './recipe.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createRuns, type RunRequest } from './runs.svelte.js';
import type { Whispering } from './whispering.svelte.js';

export type {
	AudioFile,
	RecordingAudio,
	TextRunNote,
	TransformationRunNote,
} from './folder.js';
export type { Run } from './runs.svelte.js';

type Collections = typeof NOTES;

/** A note that does not read, for the person to repair as text or delete. */
export type Repair = InvalidNote & {
	readonly collection: NoteName;
	/** Why it does not read, in a line. */
	readonly reason: string;
};

const repairsOf = <TName extends NoteName>(
	collection: TName,
	invalid: readonly InvalidNote[],
): Repair[] =>
	invalid.map((note) => ({
		...note,
		collection,
		reason: describeIssues(note.issues),
	}));

const BEING_DELETED = 'This recording is being deleted.';

/** A transcription's key, by the recording it transcribes. */
const transcriptionKey = (recordingId: string) =>
	`transcriptions:${recordingId}`;
/** A transformation run's key, by the transcript and recipe. */
const transformKey = (transcriptionId: string, recipeId: string) =>
	`transformation_runs:${transcriptionId}:${recipeId}`;
/** A pasted-text run's key, by the recipe. */
const textKey = (recipeId: string) => `text_runs:${recipeId}`;

/** A recipe run's request before it has its key and note id. */
type RecipePrepared = Omit<
	Extract<RunRequest, { collection: 'transformation_runs' | 'text_runs' }>,
	'key' | 'noteId'
>;

export function createLibrary({
	whispering,
	query,
}: {
	/** The services, the models, and whether Whispering is closing. */
	whispering: Whispering;
	/** The folder as the page's client reads and writes it. */
	query: FolderQuery;
}) {
	const { refused } = whispering;
	const { queryClient: client, folder, folderQueries } = query;
	/** What the pages show. Held here so no page owns it. */
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
		 * moves between pages or transformations. It is never
		 * written anywhere; a run takes a copy of it when it starts.
		 */
		pastedText: '',
		/**
		 * The transformation chosen for post-processing, by id. Undefined is
		 * None, which is how the page starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});

	// --- reads -----------------------------------------------------------------

	const read = createQuery(
		() => folderQueries.read(),
		() => client,
	);
	/** The folder as the query last read it. The pages open once it was read. */
	const snapshot: FolderSnapshot = $derived(read.data ?? EMPTY_FOLDER);

	const entries = $derived(
		[...snapshot.recordings.items, ...unnotedOf(snapshot)].toSorted(
			newest((note) => note.recordedAt),
		),
	);
	const transformations = $derived(
		snapshot.transformations.items.toSorted(byTitle),
	);
	const transcriptions = $derived(
		snapshot.transcriptions.items.toSorted(newest((note) => note.createdAt)),
	);
	const transformationRuns = $derived(
		snapshot.transformation_runs.items.toSorted(
			newest((note) => note.createdAt),
		),
	);
	const textRuns = $derived(
		snapshot.text_runs.items.toSorted(newest((note) => note.createdAt)),
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
		...repairsOf('recordings', snapshot.recordings.invalid),
		...repairsOf('transcriptions', snapshot.transcriptions.invalid),
		...repairsOf('transformation_runs', snapshot.transformation_runs.invalid),
	]);

	let selectedId = $state<string | undefined>();
	let selectedTransformationId = $state<string | undefined>();

	// Recordings that are gone are no longer selected in the table.
	const stopPruning = $effect.root(() => {
		$effect(() => {
			const present = new Set(entries.map((note) => note.id));
			if (ui.recordingSelected.some((id) => !present.has(id)))
				ui.recordingSelected = ui.recordingSelected.filter((id) =>
					present.has(id),
				);
		});
	});

	// --- runs ------------------------------------------------------------------

	const runs = createRuns({
		folder,
		query,
		transcribe: whispering.transcribe,
		transform: whispering.transform,
		refused,
	});
	const runList = $derived(runs.list());

	/** Recordings whose deletion is under way, by id, so no request starts for one. */
	const deleting = new SvelteSet<string>();

	/** The recipe to send: the one shown, or else its note as listed. */
	function recipeAt(
		id: string,
		shown: RecipeRow | undefined,
	): ResolvedRecipe | string {
		if (shown !== undefined) return whispering.resolve(shown);
		const recipe = snapshot.transformations.items.find(
			(note) => note.id === id,
		);
		if (recipe === undefined)
			return snapshot.transformations.invalid.some((note) => note.id === id)
				? whispering.resolve(undefined)
				: 'This transformation is no longer listed.';
		return whispering.resolve(recipe);
	}

	/** Start a recipe run whose request `prepare` makes from what is shown now. */
	async function runRecipe(
		key: string,
		prepare: () => RecipePrepared | string,
	): Promise<string | undefined> {
		const why = refused();
		if (why !== undefined) return why;
		if (runs.underWay(key))
			return 'This transformation is already running on this. Run it again when it has finished.';
		const prepared = prepare();
		if (typeof prepared === 'string') return prepared;
		// A spread keeps each field but not which collection goes with which fields.
		await runs.start({ ...prepared, key, noteId: timeId() } as RunRequest);
		return undefined;
	}

	// --- pages -----------------------------------------------------------------

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

	/** After a delete, the page state lets the note go. */
	function deleted({ collection, id }: NoteRef) {
		if (collection === 'recordings' && selectedId === id)
			selectedId = undefined;
		if (collection === 'transformations' && selectedTransformationId === id)
			selectedTransformationId = undefined;
		if (collection === 'transformations' && ui.postProcessing === id)
			ui.postProcessing = undefined;
	}

	const busy = (id: string) =>
		deleting.has(id) ? BEING_DELETED : runs.busy(id);

	return {
		ui,
		/** Whether Whispering is closing, so nothing new starts. */
		get closing() {
			return whispering.closing;
		},
		/** The selected transformation, resolved against the lists and the text model. */
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
		/** Recordings, transcripts and their results that do not read, with why. */
		get repairs() {
			return repairs;
		},
		get transcriptions() {
			return transcriptions;
		},
		/** How many bytes of audio the folder holds, as last read. */
		get audioSize() {
			return audioSizeOf(snapshot);
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
				repair: snapshot.transformations.invalid.find((note) => note.id === id),
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
			return repairsOf('transformations', snapshot.transformations.invalid);
		},
		/** Results made from one transcript, newest first. */
		outputsFor(transcriptionId: string) {
			return transformationRuns.filter(
				(note) => note.transcriptionId === transcriptionId,
			);
		},
		/** Results one transformation made from transcripts, newest first. They outlive it. */
		outputsOf(transformationId: string) {
			return transformationRuns.filter(
				(note) => note.transformationId === transformationId,
			);
		},
		/** Results on pasted text one transformation made, newest first. */
		textOutputsOf(transformationId: string) {
			return textRuns.filter(
				(note) => note.transformationId === transformationId,
			);
		},
		/** Notes in `text_runs/` that do not read as results. */
		get textRepairs(): Repair[] {
			return repairsOf('text_runs', snapshot.text_runs.invalid);
		},
		/** Where recording `id`'s audio is, read reactively. */
		audioOf: (id: string) => audioOf(snapshot, id),
		/** Recording `id`'s audio bytes. */
		async readAudio(id: string): Promise<Result<AudioBytes, string>> {
			const audio = audioOf(snapshot, id);
			if (audio.kind === 'here') return folder.readAudio(audio.file);
			return Err(
				audio.kind === 'ambiguous'
					? `More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one.`
					: 'This recording has no audio file.',
			);
		},

		// ------------------------------------------------------------------
		// Editing
		// ------------------------------------------------------------------

		/**
		 * Note `id` of `kind` as an editor: typing saves a moment later
		 * through `kind`'s writes; see `note-editor.svelte.ts`.
		 */
		edit<K extends NoteName>(
			kind: K,
			id: string,
			{ create }: { create?: () => NotePatch<Collections[K]> } = {},
		): NoteEditor<Collections[K]> {
			return editNote<Collections[K]>({
				fieldNames: folder.notes[kind].fieldNames,
				get: () =>
					(snapshot[kind].items as readonly Record<string, unknown>[]).find(
						(note) => note.id === id,
					),
				// Typing is saved over the note as shown under it now.
				save: (changes) => query.setNote(kind, id, changes),
				create,
			});
		},

		// ------------------------------------------------------------------
		// Requests and their results
		// ------------------------------------------------------------------

		/** The transcription of recording `id` under way, or what became of it. */
		transcriptionRun(id: string) {
			return runList.find((run) => run.key === transcriptionKey(id));
		},
		/** Transformation runs on transcript `id` in this window. */
		runsOn(transcriptionId: string) {
			return runList.filter(
				(run) =>
					run.collection === 'transformation_runs' &&
					run.fields.transcriptionId === transcriptionId,
			);
		},
		/** The run of recipe `id` on pasted text in this window. */
		textRun(recipeId: string) {
			return runList.find((run) => run.key === textKey(recipeId));
		},
		/** Recipe runs whose request is out. */
		get recipeRuns() {
			return runList.filter(
				(run) =>
					run.collection !== 'transcriptions' && run.state.kind === 'running',
			);
		},
		/** Run a failed run again, or save an unsaved answer again; why nothing was tried. */
		runAgain: runs.again,
		/** Forget a failed run, or an answer that was not saved. */
		dismissRun: runs.dismiss,

		/**
		 * Transcribe recording `id`: send its audio to the transcription model
		 * chosen now, then create its transcript. Answers why nothing was sent.
		 */
		async transcribe(id: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const key = transcriptionKey(id);
			if (runs.underWay(key))
				return 'This recording is already being transcribed.';
			if (deleting.has(id)) return BEING_DELETED;
			const choice = whispering.chosen('transcription');
			if (choice.kind !== 'ready') return choice.reason;
			const recording = entries.find((note) => note.id === id);
			if (recording === undefined)
				return snapshot.recordings.invalid.some((note) => note.id === id)
					? 'The recording needs repair before it is transcribed.'
					: 'The recording is no longer listed.';
			const audio = audioOf(snapshot, id);
			if (audio.kind !== 'here')
				return audio.kind === 'ambiguous'
					? `More than one audio file has this recording’s id (${audio.exts.join(', ')}). Keep one before transcribing.`
					: 'This recording has no audio to transcribe.';
			const { target } = choice;
			const at = new Date();
			await runs.start({
				collection: 'transcriptions',
				fields: {
					recordingId: id,
					createdAt: at.toISOString(),
					model: target.model,
					endpoint: target.address,
				},
				audio: audio.file,
				key,
				noteId: timeId(at),
				target,
			});
			return undefined;
		},

		/**
		 * Apply recipe `recipeId` to transcript `transcriptionId`, each as
		 * `shown` or else as listed. Its result is a new note; the transcript
		 * is never changed. Answers why nothing was sent.
		 */
		transform(
			transcriptionId: string,
			recipeId: string,
			shown: { readonly recipe?: RecipeRow; readonly input?: string } = {},
		): Promise<string | undefined> {
			return runRecipe(transformKey(transcriptionId, recipeId), () => {
				const resolved = recipeAt(recipeId, shown.recipe);
				if (typeof resolved === 'string') return resolved;
				if (resolved.kind !== 'ready') return resolved.reason;
				const transcript = snapshot.transcriptions.items.find(
					(note) => note.id === transcriptionId,
				);
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
		transformText(
			recipeId: string,
			input: string,
			shown: { readonly recipe?: RecipeRow } = {},
		): Promise<string | undefined> {
			if (input.trim() === '')
				return Promise.resolve(refused() ?? 'Paste some text to run this on.');
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

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		/**
		 * A new recipe: a title and instructions. It names no model of its own
		 * (`null`), so it runs with the text model.
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
			const saved = await query.setNote('transformations', id, {
				title,
				model: null,
				body: prompt,
			});
			if (saved.error !== null) return saved.error.message;
			openTransformation(id);
			return undefined;
		},

		/**
		 * Capture what deleting `ref` would remove, for the person to confirm,
		 * from what the lists show. Capturing changes nothing.
		 */
		deletionFor(ref: NoteRef): Result<Deletion, string> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion({ snapshot, busy }, ref);
		},
		/**
		 * Delete what was confirmed. A recording is kept if new results
		 * appeared after confirmation.
		 */
		async delete(deletion: Deletion): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const recording = recordingDeleted(deletion);
			const refusal = recording && busy(recording);
			if (refusal) return refusal;
			if (recording) deleting.add(recording);
			try {
				const problem = await runDeletion(query, snapshot, deletion);
				if (problem !== undefined) return problem;
			} finally {
				if (recording) deleting.delete(recording);
			}
			deleted(deletedNote(deletion));
			if (recording) runs.forgetRecording(recording);
			return undefined;
		},
		/** Stop following the lists. Runs under way still keep their answers. */
		dispose: stopPruning,
	};
}

export type Library = ReturnType<typeof createLibrary>;
/** The library every page reads: set by the app root (`WhisperingApp`). */
export const [getLibrary, setLibrary] = createContext<Library>();
