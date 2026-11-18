/**
 * Whispering's library: what the pages list, edit, transcribe and delete,
 * over the folder query (`folder-query.ts`). The folder is the one `app.ts`
 * opened over the `Files` the build chose; nothing here knows which.
 *
 * Every list here is derived from the folder query's answer. Notes that
 * read are listed to edit; the rest are named, with why and their text, for
 * repair. A recording's audio with no note lists as an untitled recording.
 * Nothing here holds text ahead of the folder: what a person types is an
 * editor's (`note-editor.svelte.ts`), and a write that fails says why.
 *
 * A transcription is a mutation over the runs service (`runs.ts`): which
 * recordings are being transcribed is read from the mutation cache, so a
 * run started anywhere shows everywhere. A failed run is its mutation's
 * error, shown where it was started.
 * A recording is transcribed or deleted one at a time (`busy`).
 *
 * The library is made when the app's pages open and let go when they
 * close. Leaving waits for nothing and refuses nothing: a run under way
 * still keeps its answer in the files, unless Whispering itself is closing.
 */

import { createQuery, useMutationState } from '@tanstack/svelte-query';
import { createContext } from 'svelte';
import { resultMutations, runMutation } from 'wellcrafted/query';
import { Err, type Result } from 'wellcrafted/result';
import {
	captureDeletion,
	type Deletion,
	deletedNote,
	recordingDeleted,
	runDeletion,
} from './deletion.js';
import {
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
import type { NOTES } from './format/layout.js';
import { editNote, type NoteEditor } from './note-editor.svelte.js';
import { fieldNamesFor, type NotePatch } from './notes.js';
import { DEFAULT_SORT, type RecordingSort } from './recordings-table.js';
import { createRuns, RunError } from './runs.js';
import type { Whispering } from './whispering.svelte.js';

export type { AudioFile, RecordingAudio } from './folder.js';

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

/** What a recording can be busy with: one at a time, never both. */
type Work = 'transcribing' | 'deleting';

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
	const { queryClient: client, folder, folderQueries, folderMutations } = query;
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

	// The take under way is the record screen's until its note is written,
	// though on the desktop its audio is at its path (ADR-0962).
	const entries = $derived(
		[
			...snapshot.recordings.items,
			...unnotedOf(snapshot).filter(
				(note) => note.id !== whispering.takeInProgress,
			),
		].toSorted(newest((note) => note.recordedAt)),
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

	/**
	 * What each recording is busy with now, by id. A recording is either
	 * transcribed or deleted, one at a time: neither starts while the other,
	 * or another of the same, is under way. Work claims its recording here
	 * synchronously, so two presses in one moment cannot both pass.
	 */
	const busy = new Map<string, Work>();
	/** Why `work` cannot start for recording `id` now, or nothing when it can. */
	function busyWith(id: string, work: Work): string | undefined {
		const under = busy.get(id);
		if (under === undefined) return undefined;
		if (under === 'deleting') return 'This recording is being deleted.';
		return work === 'transcribing'
			? 'This recording is already being transcribed.'
			: 'This recording is still being transcribed. Wait for it to finish, then delete it.';
	}

	const runs = createRuns({
		folder,
		chosen: whispering.chosen,
		transcribe: whispering.transcribe,
		refused,
	});
	/** Transcribe recording `recordingId` while nothing else is under way for it. */
	async function transcribe({
		recordingId,
	}: {
		recordingId: string;
	}): Promise<Result<undefined, RunError>> {
		const why = busyWith(recordingId, 'transcribing');
		if (why !== undefined) return RunError.NotSent({ reason: why });
		busy.set(recordingId, 'transcribing');
		try {
			return await runs.transcribe({ recordingId });
		} finally {
			busy.delete(recordingId);
		}
	}
	const runMutations = resultMutations(['runs'], { transcribe });

	/** The recordings being transcribed now, by id, from the mutation cache. */
	let transcribingIds: readonly string[] = [];
	const stopFollowingRuns = $effect.root(() => {
		transcribingIds = useMutationState(
			{
				filters: {
					mutationKey: runMutations.transcribe.mutationKey,
					status: 'pending',
				},
				select: (mutation) =>
					(mutation.state.variables as { recordingId: string }).recordingId,
			},
			client,
		);
	});

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
		transcriptsFor(id: string) {
			return transcriptsByRecording.get(id) ?? [];
		},
		/** Where recording `id`'s audio is, read reactively. */
		audioOf: (id: string) => audioOf(snapshot, id),
		/** Recording `id`'s audio bytes, or why they cannot be read. */
		readAudio: folder.readAudio,

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
				fieldNames: fieldNamesFor(kind),
				get: () =>
					(snapshot[kind].items as readonly Record<string, unknown>[]).find(
						(note) => note.id === id,
					),
				save: ({ fields, body }) =>
					runMutation(client, folderMutations.notes.set, {
						collection: kind,
						id,
						fields,
						body,
					}),
				create,
			});
		},

		// ------------------------------------------------------------------
		// Transcription
		// ------------------------------------------------------------------

		/** Transcribe a recording, as a mutation a component observes. */
		transcription: runMutations.transcribe,
		/** Whether recording `id` is being transcribed, wherever that was started. */
		transcribing: (id: string): boolean => transcribingIds.includes(id),
		/**
		 * Transcribe recording `id` through the page's client, for a caller
		 * that wants its outcome rather than to observe it (the table's
		 * action on several recordings).
		 */
		transcribe: (id: string) =>
			runMutation(client, runMutations.transcribe, { recordingId: id }),

		/**
		 * Capture what deleting `ref` would remove, for the person to confirm,
		 * from what the lists show. Capturing changes nothing.
		 */
		deletionFor(ref: NoteRef): Result<Deletion, string> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion(
				{ snapshot, busy: (id) => busyWith(id, 'deleting') },
				ref,
			);
		},
		/**
		 * Delete what was confirmed. A recording is kept if new transcripts
		 * appeared after confirmation.
		 */
		async delete(deletion: Deletion): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const recording = recordingDeleted(deletion);
			const refusal = recording && busyWith(recording, 'deleting');
			if (refusal) return refusal;
			if (recording) busy.set(recording, 'deleting');
			try {
				const problem = await runDeletion(
					{
						deleteNote: (note) =>
							runMutation(client, folderMutations.notes.delete, note),
						deleteAudio: (id) =>
							runMutation(client, folderMutations.audio.delete, { id }),
					},
					snapshot,
					deletion,
				);
				if (problem !== undefined) return problem;
			} finally {
				if (recording) busy.delete(recording);
			}
			deleted(deletedNote(deletion));
			return undefined;
		},
		/** Stop following the lists. Runs under way still keep their answers. */
		dispose() {
			stopPruning();
			stopFollowingRuns();
		},
	};
}

export type Library = ReturnType<typeof createLibrary>;
/** The library every page reads: set by the app root (`WhisperingApp`). */
export const [getLibrary, setLibrary] = createContext<Library>();
