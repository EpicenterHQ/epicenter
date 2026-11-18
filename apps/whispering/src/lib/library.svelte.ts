/**
 * Whispering's library: what the pages list, edit, transcribe and delete,
 * over the folder query (`folder-query.ts`). The folder is the one `app.ts`
 * opened over the `Files` the build chose; nothing here knows which.
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
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createRuns } from './runs.svelte.js';
import type { Whispering } from './whispering.svelte.js';

export type { AudioFile, RecordingAudio } from './folder.js';
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
	const transcriptions = $derived(
		snapshot.transcriptions.items.toSorted(newest((note) => note.createdAt)),
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
	]);

	let selectedId = $state<string | undefined>();

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
		refused,
	});
	const runList = $derived(runs.list());

	/** Recordings whose deletion is under way, by id, so no request starts for one. */
	const deleting = new SvelteSet<string>();

	// --- pages -----------------------------------------------------------------

	/** Show recording `id` beside the recordings. Opening never waits or asks. */
	function openRecording(id: string): boolean {
		if (whispering.closing) return false;
		selectedId = id;
		return true;
	}

	/** After a delete, the page state lets the note go. */
	function deleted({ collection, id }: NoteRef) {
		if (collection === 'recordings' && selectedId === id)
			selectedId = undefined;
	}

	const busy = (id: string) =>
		deleting.has(id) ? BEING_DELETED : runs.busy(id);

	return {
		ui,
		/** Whether Whispering is closing, so nothing new starts. */
		get closing() {
			return whispering.closing;
		},
		/** Recordings that read, newest first. */
		get entries() {
			return entries;
		},
		/** Recordings and transcripts that do not read, with why. */
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
		openRecording,

		// ------------------------------------------------------------------
		// Lists
		// ------------------------------------------------------------------

		/** Transcripts of one recording, newest first. */
		resultsFor(id: string) {
			return transcriptsByRecording.get(id) ?? [];
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
