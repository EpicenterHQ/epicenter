/**
 * The mounted Whispering app state over one opened folder
 * (`@epicenter/svelte/folder`).
 *
 * The folder is a mirror of what landed on disk, read reactively and in full:
 * every list here is derived from its rows and files, once per change. Rows
 * that read are listed to edit; the rest are named, with why, for repair as
 * text. A row whose read failed is one of them, and Try again looks at the
 * folder again.
 *
 * Nothing here holds text ahead of the disk: what a person types is a draft
 * in the view that shows it, and each write answers once it landed and the
 * mirror shows it. The caller of a write presents a failure.
 *
 * Closing waits for nothing here: `dispose` refuses new work and late answers
 * and returns. `<OpenFolder>` closes the folder after this, sending the
 * writes that wait. Provider requests and recording workflows follow the
 * closing fence and never delay disposal. A recording under way ends with
 * the page (ADR-0663).
 *
 * A recording is in the folder from the moment it starts (ADR-0543): its row
 * is written then beside its same-stem audio. On the desktop the audio is
 * written as it is captured. Whether it is still running is this window's live
 * capture, never a field. A transcription or recipe run is in the folder
 * from its start too (ADR-0542): its result row is written before the request
 * goes out, and its body when the answer arrives (`runs.svelte.ts`).
 */

import { InstantString } from '@epicenter/definition';
import {
	type FolderFile,
	type Row,
	describeIssues,
	readRow,
} from '@epicenter/folder';
import { ancestors, dirname, joinPath } from '@epicenter/folder/file-browser';
import { customAlphabet } from 'nanoid';
import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { Err, type Result } from 'wellcrafted/result';
import { createServices } from '#platform/services';
import { audioMimeTypeOf } from './audio-format.js';
import { type ActiveCapture, CaptureError } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import {
	RECORDINGS,
	type RecordingFields,
	recordingAudioStem,
	rowIdOf,
	rowPath,
	TEXT_RUNS,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
	whisperingTables,
	type WhisperingTables,
} from './definition.js';
import {
	captureDeletion,
	type Deletion,
	type DeletionContext,
	recordingTitle,
	runDeletion,
} from './deletion.js';
import { maintainExclusions } from './exclusions.js';
import { describeError, listingOf, nameProblem } from './files.js';
import type { WhisperingFolder } from './folder.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { PostProcessingChoice } from './post-processing.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { type RecordingAudio, recordingAudio } from './recording-audio.js';
import { DEFAULT_SORT, type RecordingSort } from './recording-collection.js';
import { createRuns } from './runs.svelte.js';
import { createSettingsDraft } from './settings-draft.svelte.js';

export const STOPPED = 'Whispering stopped before it finished starting.';

export type TableName = keyof WhisperingTables;
/** The tables whose rows this window edits. */
export type RowTable =
	| typeof RECORDINGS
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATIONS;

/** A row of `table` as listed: its exact source, its fields, and its issues. */
export type ListedRow<T extends TableName> = Row<WhisperingTables[T]>;
/** A row whose fields read through its table's schema. */
export type ReadRow<T extends TableName> = Extract<
	ListedRow<T>,
	{ issues: null }
>;
/** A listed row that reads, with its file. `stem` is its ID. */
export type Entry<T extends TableName> = {
	readonly stem: string;
	readonly path: string;
	readonly row: ReadRow<T>;
};
export type RecordingEntry = Entry<'recordings'>;
export type TranscriptionEntry = Entry<'transcriptions'>;
export type TransformationEntry = Entry<'transformations'>;
export type TransformationRunEntry = Entry<'transformation_runs'>;
export type TextRunEntry = Entry<'text_runs'>;
/** A row file that does not read as a row, and why, for the person to repair as text. */
export type Repair = {
	readonly path: string;
	readonly stem: string;
	readonly reason: string;
	/** Its read failed, so looking at the folder again may read it. */
	readonly unreadable: boolean;
};

export type { Deletion } from './deletion.js';
export type {
	RecipeRun,
	ResultState,
	TranscriptionRun,
} from './runs.svelte.js';

/** What the recordings page shows: a recording, or any other file opened beside the recordings. */
export type Selection = {
	readonly kind: 'recording' | 'file';
	readonly path: string;
	/** The listed recording, for a recording that reads. */
	readonly entry: RecordingEntry | undefined;
};

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

const CLOSING = 'Whispering is closing, so nothing was changed.';
const RECORDING_NAME =
	'A recording’s file is named by its ID, which its transcription results refer to. Change the title instead.';
const RECORDING_AUDIO_NAME =
	'This audio file belongs to a recording, so renaming it would break the link. Change the recording’s title instead.';
const TRANSFORMATION_NAME =
	'A transformation’s file is named by its ID, which its saved results refer to. Change the title instead.';
const TRANSCRIPT_NAME = 'A transcript file keeps its .md extension.';
const STILL_TEXT =
	'Its text still does not read as a row. Fix what the notice names first.';
const TAKEN = 'Another file already has this name, so nothing was changed.';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** A sortable id from a time: `20260102-030405-k3f9`. */
export function recordingId(at: Date): string {
	const stamp = at
		.toISOString()
		.replace(/\.\d+Z$/, '')
		.replace(/[-:]/g, '')
		.replace('T', '-');
	return `${stamp}-${suffix()}`;
}

function defaultTitle(at: Date): string {
	return `Recording ${at.toLocaleString(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	})}`;
}

/** The row table a path is a row of, if it is one this window edits. */
export function rowTableOf(path: string): RowTable | undefined {
	for (const table of [RECORDINGS, TRANSCRIPTIONS, TRANSFORMATIONS] as const)
		if (rowIdOf(table, path) !== undefined) return table;
	return undefined;
}

/** A listing's rows that read, and the rest with why. */
function split<T extends TableName>(table: T, rows: readonly ListedRow<T>[]) {
	const entries: Entry<T>[] = [];
	const repairs: Repair[] = [];
	for (const row of rows) {
		const path = rowPath(table, row.id);
		if (row.issues === null)
			// SAFETY: a row with no issues read through its table's schema.
			entries.push({ stem: row.id, path, row: row as ReadRow<T> });
		else
			repairs.push({
				path,
				stem: row.id,
				reason: describeIssues(row.issues),
				unreadable: row.issues.some((issue) => issue.kind === 'unreadable'),
			});
	}
	return {
		entries,
		repairs,
		paths: new Set(rows.map((row) => rowPath(table, row.id))),
	};
}

const byPath = (a: { path: string }, b: { path: string }) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** Newest first. */
function byNewest<
	TEntry extends {
		readonly row: { readonly fields: { readonly createdAt: string } };
	},
>(list: readonly TEntry[]): TEntry[] {
	return [...list].sort((a, b) =>
		b.row.fields.createdAt.localeCompare(a.row.fields.createdAt),
	);
}

/** One derived value per rows or files array the mirror answers, computed once per array. */
function perListing<TListing extends object, TValue>(
	compute: (listing: TListing) => TValue,
) {
	const seen = new WeakMap<TListing, TValue>();
	return (listing: TListing): TValue => {
		let value = seen.get(listing);
		if (value === undefined) {
			value = compute(listing);
			seen.set(listing, value);
		}
		return value;
	};
}

export function createWhispering(folder: WhisperingFolder) {
	const services = createServices(folder);
	/** What the shell shows. Held here so no route owns it. */
	const view = $state({
		sidebarOpen: false,
		/** The file browser beside the page, on a wide window. */
		filesPane: false,
		/** The file browser in a sheet, on a narrow window. */
		filesSheet: false,
		/** The recordings search. Rows needing repair are never searched out. */
		recordingQuery: '',
		/** The order of the recordings table. */
		recordingSort: DEFAULT_SORT as RecordingSort,
		/**
		 * The recordings selected in the table, by row path. A successful
		 * listing removes paths that left the folder; search keeps hidden selections.
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
		/** The transcription a transformation is tried on, by row path. */
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
		 * The transformation chosen for post-processing, by row path. Undefined
		 * is None, which is how the app starts. Choosing sends nothing: a
		 * transformation runs only when the person asks for it.
		 */
		postProcessing: undefined as string | undefined,
	});
	let exclusionNotice = $state<string | undefined>();
	let starting: Promise<void> | undefined;

	/** Product cleanup also fences new work and late replies. */
	let disposed = false;
	let captureNotice = $state<string | undefined>();
	/** Why nothing new starts now, if it does not. */
	const refused = () => (disposed ? CLOSING : undefined);

	// --- reads -----------------------------------------------------------------

	/** A table's complete mirrored rows, read reactively. */
	function listed<T extends TableName>(table: T) {
		// SAFETY: the table key selects the same schema as ListedRow<T>.
		return folder.tables[table].rows as readonly ListedRow<T>[];
	}
	const listedFiles = perListing((files: readonly FolderFile[]) =>
		listingOf(files.map((file) => file.path)),
	);
	/** The folder's complete file listing, read reactively. */
	function listing() {
		return listedFiles(folder.files);
	}

	const recordingsOf = perListing((rows: readonly ListedRow<'recordings'>[]) => {
		const read = split(RECORDINGS, rows);
		return {
			...read,
			entries: read.entries.sort(
				(a, b) =>
					b.row.fields.recordedAt.localeCompare(a.row.fields.recordedAt) ||
					byPath(b, a),
			),
			repairs: read.repairs.sort(byPath),
		};
	});
	const transformationsOf = perListing(
		(rows: readonly ListedRow<'transformations'>[]) => {
			const read = split(TRANSFORMATIONS, rows);
			const key = (entry: TransformationEntry) =>
				entry.row.fields.title || entry.path;
			return {
				...read,
				entries: read.entries.sort(
					(a, b) =>
						key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }) ||
						byPath(a, b),
				),
				repairs: read.repairs.sort(byPath),
			};
		},
	);
	const transcriptionsOf = perListing(
		(rows: readonly ListedRow<'transcriptions'>[]) =>
			split(TRANSCRIPTIONS, rows).entries,
	);
	const resultsOf = perListing(
		(rows: readonly ListedRow<'transformation_runs'>[]) =>
			split(TRANSFORMATION_RUNS, rows).entries,
	);
	const textResultsOf = perListing((rows: readonly ListedRow<'text_runs'>[]) =>
		split(TEXT_RUNS, rows),
	);

	const recordingsRead = () => recordingsOf(listed(RECORDINGS));
	const transformationsRead = () => transformationsOf(listed(TRANSFORMATIONS));
	const entries = () => recordingsRead().entries;

	// --- editing ---------------------------------------------------------------

	/** Row files the person chose to edit as their exact text. */
	const asText = new SvelteSet<string>();

	/**
	 * Whether `path` shows as its exact text: a row file the person opened in
	 * Source, or one whose text does not read as a row.
	 */
	function showsText(path: string): boolean {
		const table = rowTableOf(path);
		if (table === undefined) return true;
		if (asText.has(path)) return true;
		const stem = rowIdOf(table, path);
		const row = stem === undefined ? undefined : folder.tables[table].row(stem);
		return row !== undefined && row.issues !== null;
	}

	/** After a rename, the view state and selection follow the file. */
	function moved(from: string, to: string) {
		if (asText.delete(from)) asText.add(to);
		if (selectedPath === from) selectedPath = to;
	}

	/** After a delete, the view state and selection let the file go. */
	function deleted(path: string) {
		runs.forget(path);
		const recording = rowIdOf(RECORDINGS, path);
		if (recording !== undefined) justFinished.delete(recording);
		for (const [id, audioPath] of justFinished)
			if (audioPath === path) justFinished.delete(id);
		asText.delete(path);
		if (selectedPath === path) selectedPath = undefined;
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
	}

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

	let selectedPath = $state<string | undefined>();
	let selectedTransformationPath = $state<string | undefined>();

	type CaptureState =
		| { phase: 'idle' }
		| { phase: 'starting'; attempt: AbortController }
		| {
				phase: 'recording';
				id: string;
				capture: ActiveCapture;
				/** Its initial row save, awaited before Stop writes the row's length. */
			rowSave: ReturnType<typeof folder.tables.recordings.create>;
		  }
		| { phase: 'stopping'; id: string; capture: ActiveCapture };
	let captureState = $state.raw<CaptureState>({ phase: 'idle' });
	/**
	 * The last Stop until it has finished, its row's length included, though
	 * the microphone is free sooner. A Stop pressed again meanwhile joins it.
	 */
	let finishing: Promise<void> | undefined;
	let recorderError = $state<string | undefined>();
	/** A recording owns its microphone until Stop answers. */
	function isCapturing(id: string) {
		return (
			(captureState.phase === 'recording' ||
				captureState.phase === 'stopping') &&
			captureState.id === id
		);
	}
	/**
	 * Recordings this window just finished, by stem, with the audio path
	 * their capture wrote. Until the mirror lists that audio, it plays from
	 * this path and is not reported absent.
	 */
	const justFinished = new Map<string, string>();
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	// Recordings that left the folder are no longer selected in the table.
	const stopPruning = $effect.root(() => {
		$effect(() => {
			const { paths } = recordingsRead();
			if (view.recordingSelected.some((path) => !paths.has(path)))
				view.recordingSelected = view.recordingSelected.filter((path) =>
					paths.has(path),
				);
		});
	});

	const runs = createRuns({
		folder,
		transcribe: (request) => services.transcribe(request),
		transform: (request) => services.transform(request),
		makeId: recordingId,
		refused,
		connections: () => ({ info: connections, error: connectionsError }),
		resolve,
		deleting,
		isCapturing,
		audioOf: (id) => audioFor(id),
	});

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => captureState.phase !== 'idle',
	});

	/** Show `path`: a transformation on its page, anything else beside the recordings. Opening never waits or asks. */
	function open(path: string): boolean {
		if (disposed) return false;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (rowTableOf(path) === TRANSFORMATIONS) selectedTransformationPath = path;
		else selectedPath = path;
		return true;
	}

	// --- recording ----------------------------------------------------------

	/**
	 * Stop: finish the recording being captured. Its audio file is finalized
	 * and its length written to its row, which was written when it started. A
	 * row that cannot take its length keeps everything else, and says why. A
	 * Stop pressed again joins the first until it has finished. Once closed,
	 * nothing is finished here: leaving the page ends the capture.
	 */
	function finishRecording(): Promise<void> {
		const current = captureState;
		if (current.phase !== 'recording' || disposed)
			return finishing ?? Promise.resolve();
		captureState = {
			phase: 'stopping',
			id: current.id,
			capture: current.capture,
		};
		const finished = finish(current);
		finishing = finished;
		const forget = () => {
			if (finishing === finished) finishing = undefined;
		};
		finished.then(forget, forget);
		return finished;
	}

	async function finish({
		id,
		capture,
		rowSave,
	}: Extract<CaptureState, { phase: 'recording' }>) {
		const path = rowPath(RECORDINGS, id);
		const selectionBefore = selectedPath;
		// In a browser, and for fixture audio, the audio file is written now; on
		// the desktop it was written as it was captured, and stop finishes it.
		// Start immediately so the microphone is let go before row work finishes.
		const stopping = capture
			.stop()
			.catch((cause) => CaptureError.Failed({ cause }));
		const { data: stopped, error: stopError } = await stopping;
		if (stopError === null) justFinished.set(id, capture.audioPath);
		// Look at the folder now, so the finished audio is listed soon.
		void folder.refresh().then(() => {
			if (!listing().byStem.get(recordingAudioStem(id))?.some((path) => audioMimeTypeOf(path) !== undefined))
				justFinished.delete(id);
		});
		captureState = { phase: 'idle' };
		// Closed meanwhile: the folder is closing, so the length is not written.
		if (disposed) return;
		if (stopError !== null) {
			recorderError = stopError.message;
			return;
		}
		const saveDuration = async () => {
			const { error: rowError } = await rowSave;
			if (rowError !== null)
				return `The audio is saved, but its recording file could not be written: ${describeError(rowError)}. Its audio is ${capture.audioPath}.`;
			// A Stop that finishes after close writes no length.
			if (disposed) return undefined;
			const { error } = await folder.tables.recordings.update(id, {
				fields: { durationMs: stopped.durationMs },
			});
			return error === null || error.name === 'NothingToUpdate'
				? undefined
				: `The recording is saved, but its length could not be written: ${describeError(error)}`;
		};
		const saveWarning = await saveDuration().catch((cause: unknown) =>
			// Whatever fails as the page goes is not shown.
			disposed
				? undefined
				: `The recording is saved, but its length could not be written: ${describe(cause)}`,
		);
		if (saveWarning !== undefined) recorderError = saveWarning;
		if (selectedPath === selectionBefore) open(path);
	}

	/** Where the recording `id`'s audio is, by the listing the mirror shows. */
	function audioFor(id: string): RecordingAudio {
		const files = listing();
		if (
			justFinished.has(id) &&
			files.byStem
				.get(recordingAudioStem(id))
				?.some((path) => audioMimeTypeOf(path) !== undefined)
		)
			justFinished.delete(id);
		return recordingAudio(id, {
			capturePath:
				(captureState.phase === 'recording' ||
					captureState.phase === 'stopping') &&
				captureState.id === id
					? captureState.capture.audioPath
					: justFinished.get(id),
			listing: files,
			settling: justFinished.has(id) || isCapturing(id),
		});
	}

	function audioOf(entry: RecordingEntry): RecordingAudio {
		return audioFor(entry.stem);
	}

	function recordingNaming(path: string): RecordingEntry | undefined {
		return entries().find((entry) => {
			const audio = audioOf(entry);
			return audio.kind === 'here' && audio.path === path;
		});
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		busy: (id) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
		audioOf: audioFor,
		namingAudio: (path) => {
			const entry = recordingNaming(path);
			return entry && recordingTitle(entry);
		},
	});

	/** Whether `path` is taken by a file, or by a directory files are in, as last listed. */
	function taken(path: string) {
		const files = listing();
		return (
			files?.paths.has(path) === true ||
			files?.directories.includes(path) === true
		);
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
		stopPruning();
	}

	const settings = createSettingsDraft(
		services.connections.defaults,
		() => connections,
		saveConnection,
	);

	return {
		services,
		view,
		settings,
		get exclusionNotice() {
			return exclusionNotice;
		},
		/** The selected transformation, resolved against the current files and connection. */
		get postProcessing(): PostProcessingChoice {
			const path = view.postProcessing;
			if (path === undefined) return { kind: 'none' };
			const entry = transformationsRead().entries.find(
				(item) => item.path === path,
			);
			if (entry === undefined) return { kind: 'missing', path };
			const resolved = resolve(entry.row);
			return resolved.kind === 'ready'
				? { kind: 'ready', entry }
				: { kind: 'repair', entry, reason: resolved.reason };
		},
		/** The microphone the next recording uses, and the test of it. */
		input,
		/** Recordings that read, newest first. */
		get entries() {
			return entries();
		},
		/** Recording files that do not read as recordings, with why. */
		get repairs() {
			return recordingsRead().repairs;
		},
		get transcriptions() {
			return transcriptionsOf(listed(TRANSCRIPTIONS));
		},
		/** Every file in the folder, as the mirror lists it. */
		get listing() {
			return listing();
		},
		expanded,
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
		 * itself all use. Undefined is a recipe whose file does not read.
		 */
		resolve,

		// ------------------------------------------------------------------
		// Selection
		// ------------------------------------------------------------------

		get selectedPath() {
			return selectedPath;
		},
		/** What the recordings page shows while its file remains in the folder. */
		get selection(): Selection | undefined {
			const path = selectedPath;
			if (path === undefined || folder.file(path) === undefined)
				return undefined;
			if (rowTableOf(path) !== RECORDINGS)
				return { kind: 'file', path, entry: undefined };
			return {
				kind: 'recording',
				path,
				entry: entries().find((entry) => entry.path === path),
			};
		},
		get selectedTransformationPath() {
			return selectedTransformationPath;
		},
		/** The transformation being edited, with its listed row when it reads. */
		get selectedTransformation() {
			const path = selectedTransformationPath;
			if (path === undefined || folder.file(path) === undefined)
				return undefined;
			return {
				path,
				entry: transformationsRead().entries.find(
					(entry) => entry.path === path,
				),
			};
		},
		/** Select `path` immediately; false after close. Selection reads no file. */
		open,
		/** Retire mounted editors before renaming a file from the tree. */
		clearSelection() {
			selectedPath = undefined;
			selectedTransformationPath = undefined;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		/** Whether `path` shows as its exact text rather than its fields. */
		showsText,
		/** Whether a save is waiting or running; read reactively. */
		get saving() {
			return folder.saving;
		},
		/** Look at the folder again, as Try again after a read failed. */
		refresh(): void {
			void folder.refresh();
		},
		/** Show a row file as its exact text; nothing is saved or read. */
		editSource(path: string): string | undefined {
			const why = refused();
			if (why !== undefined) return why;
			asText.add(path);
			return undefined;
		},
		/** Show a row's fields again when `source`, the text shown, reads as the row. */
		useForm(path: string, source: string): string | undefined {
			const why = refused();
			if (why !== undefined) return why;
			const table = rowTableOf(path);
			if (table === undefined) return STILL_TEXT;
			if (readRow(source, whisperingTables[table]).issues !== null)
				return STILL_TEXT;
			asText.delete(path);
			return undefined;
		},

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		get closing() {
			return disposed;
		},

		// ------------------------------------------------------------------
		// Starting
		// ------------------------------------------------------------------

		/** Why recordings cut off by a quit or crash could not be checked. */
		get captureNotice() {
			return captureNotice;
		},
		/** Maintain exclusions, recover audio, then read connections and input. */
		start(): Promise<void> {
			starting ??= (async () => {
				try {
					if (disposed) throw new Error(STOPPED);
					const { error } = await maintainExclusions(folder);
					if (disposed) throw new Error(STOPPED);
					exclusionNotice = error === null ? undefined : describeError(error);
					const notice = await services.recoverRecordings();
					if (disposed) throw new Error(STOPPED);
					captureNotice = notice;
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

		/** Whether `path` is a recording file, whether or not it reads as one. */
		isRecording(path: string) {
			return recordingsRead().paths.has(path);
		},
		/** Saved transcripts of one recording, newest first. */
		resultsFor(id: string): TranscriptionEntry[] {
			return byNewest(
				transcriptionsOf(listed(TRANSCRIPTIONS)).filter(
					(entry) => entry.row.fields.recordingId === id,
				),
			);
		},
		/** Transformations that read, by title. */
		get transformations() {
			return transformationsRead().entries;
		},
		/** Transformation files that do not read as transformations, with why. */
		get transformationRepairs() {
			return transformationsRead().repairs;
		},
		isTransformation(path: string) {
			return transformationsRead().paths.has(path);
		},
		get transformationResults() {
			return byNewest(resultsOf(listed(TRANSFORMATION_RUNS)));
		},
		/** Saved results made from one transcription, newest first. */
		outputsFor(transcriptionId: string): TransformationRunEntry[] {
			return byNewest(
				resultsOf(listed(TRANSFORMATION_RUNS)).filter(
					(entry) => entry.row.fields.transcriptionId === transcriptionId,
				),
			);
		},
		/** Saved results one transformation produced, newest first. They outlive it. */
		outputsOf(transformationId: string): TransformationRunEntry[] {
			return byNewest(
				resultsOf(listed(TRANSFORMATION_RUNS)).filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		/** Saved results on pasted text one recipe produced, newest first. */
		textOutputsOf(transformationId: string): TextRunEntry[] {
			return byNewest(
				textResultsOf(listed(TEXT_RUNS)).entries.filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		/** Files in `text_runs/` that do not read as results. */
		get textRepairs() {
			return textResultsOf(listed(TEXT_RUNS)).repairs;
		},
		/** The recording whose row names `path` as its audio, if one does. */
		recordingNaming,
		/**
		 * Whether the audio `entry` names is in this device's folder: here,
		 * absent, or named nowhere. Read reactively. A recording this window is
		 * still capturing or writing is never reported absent.
		 */
		audioOf,

		// ------------------------------------------------------------------
		// Recording
		// ------------------------------------------------------------------

		/** The live capture writing `path`, until its audio has finished stopping. */
		capturePhase(path: string): 'recording' | 'stopping' | undefined {
			return (captureState.phase === 'recording' ||
				captureState.phase === 'stopping') &&
				captureState.capture.audioPath === path
				? captureState.phase
				: undefined;
		},

		get recorder(): RecorderState {
			return captureState.phase === 'recording'
				? { phase: 'recording', startedAt: captureState.capture.startedAt }
				: { phase: captureState.phase };
		},
		get recorderError() {
			return recorderError;
		},
		/**
		 * Start a recording: its audio file is named and its row written now,
		 * so a quit, a crash, or a closed window leaves both in the folder.
		 */
		async startRecording() {
			if (captureState.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			const attempt = new AbortController();
			captureState = { phase: 'starting', attempt };
			input.release();
			const at = new Date();
			const id = recordingId(at);
			const { data: capture, error: startError } = await services.capture.start(
				{
					folder,
					path: recordingAudioStem(id),
					input: input.choice,
					signal: attempt.signal,
				},
			);
			// Closed while the microphone was opening. An aborted opener releases
			// its microphone; after native destruction, page departure owns one
			// that already answered. Neither writes a row.
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
			// Facts only: when it started and where its audio is. Its length
			// follows when it stops.
			const fields: RecordingFields = {
				title: defaultTitle(at),
				recordedAt: InstantString.fromDate(at),
				capture: services.capture.source,
			};
			// Keep the capture installed even if admitting its row throws.
			const creating = folder.tables.recordings.create(id, { fields, body: '' });
			// Stop awaits this capture's own initial row save.
			captureState = { phase: 'recording', id, capture, rowSave: creating };
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
				// Stop owns finalization; it keeps the captured audio and this row.
				void finishRecording();
			});
			const created = await creating;
			if (
				created.error !== null &&
				captureState.phase === 'recording' &&
				captureState.capture === capture &&
				recorderError === undefined
			)
				recorderError = `The recording is running, but its file could not be written, so it is not listed: ${describeError(created.error)}. Its audio is ${capture.audioPath}.`;
		},
		/** Stop: the audio file is finished and the row gets its length. */
		stopRecording: finishRecording,

		// ------------------------------------------------------------------
		// Requests and their results
		// ------------------------------------------------------------------

		transcriptionRun: runs.transcriptionRun,
		dismissRun: runs.dismissRun,
		resultState: runs.resultState,
		get recipeRuns() {
			return runs.recipeRuns;
		},
		/** Answers that arrived and whose file could not be written; each is saved again when asked. */
		get unwrittenAnswers() {
			return runs.unwritten;
		},
		transcribe: runs.transcribe,
		transform: runs.transform,
		transformText: runs.transformText,
		runAgain: runs.runAgain,
		saveAgain: runs.saveAgain,

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		/**
		 * A new recipe file: a title and instructions. It names no model of its
		 * own (`null`), so it runs with the text connection.
		 */
		async createTransformation({
			title,
			prompt,
		}: {
			title: string;
			prompt: string;
		}) {
			const why = refused();
			if (why !== undefined) return why;
			const id = recordingId(new Date());
			const path = rowPath(TRANSFORMATIONS, id);
			try {
				const { error } = await folder.tables.transformations.create(id, {
					fields: { title, model: null },
					body: prompt,
				});
				if (error !== null) {
					return describeError(error);
				}
			} catch (cause) {
				return describe(cause);
			}
			if (disposed) return undefined;
			open(path);
			return undefined;
		},

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to the folder.
		 */
		saveConnection,
		/** Read the connections again, as after a failed read. */
		readConnections,

		/**
		 * Copy the file as the mirror shows it, or its bytes for a file the
		 * mirror does not keep, to a new name, then delete the old path. The
		 * two are separate writes in the folder's queue: an outside change the
		 * folder has not heard of is lost, and a failed delete leaves both files.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const directory = dirname(path);
			const problem = nameProblem(directory, name);
			if (problem !== undefined) return problem;
			const to = joinPath(directory, name);
			if (to === path) return undefined;
			if (rowIdOf(RECORDINGS, path) !== undefined) return RECORDING_NAME;
			if (rowIdOf(TRANSFORMATIONS, path) !== undefined)
				return TRANSFORMATION_NAME;
			if (recordingNaming(path) !== undefined) return RECORDING_AUDIO_NAME;
			if (
				rowIdOf(TRANSCRIPTIONS, path) !== undefined &&
				rowIdOf(TRANSCRIPTIONS, to) === undefined &&
				!showsText(path)
			)
				return TRANSCRIPT_NAME;
			if (taken(to)) return TAKEN;
			const before = folder.file(path);
			if (before === undefined) return `No file exists at '${path}'.`;
			let data: string | Uint8Array;
			if (typeof before.data === 'string') data = before.data;
			else {
				const { data: bytes, error } = await folder.read(path);
				if (error !== null) return describeError(error);
				if (bytes === null) return `No file exists at '${path}'.`;
				data = bytes;
			}
			const { error: copyError } = await folder.write(to, data);
			if (copyError !== null) return describeError(copyError);
			const { error: removeError } = await folder.delete(path);
			if (removeError !== null) {
				return `${to} was saved, but ${path} was not deleted: ${describeError(removeError)}`;
			}
			if (!disposed) moved(path, to);
			return undefined;
		},
		/** A new empty text file, shown; it is never made where a file is listed. */
		async createFile(directory: string, name: string) {
			const why = refused();
			if (why !== undefined) return why;
			try {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (taken(path)) return `"${name}" already exists here.`;
				const { error } = await folder.write(path, '');
				if (error !== null) {
					return describeError(error);
				}
				open(path);
				return undefined;
			} catch (cause) {
				return describe(cause);
			}
		},
		/**
		 * Capture what deleting `path` would remove, for the person to confirm,
		 * from what the mirror shows. Capturing changes nothing.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion(deletionContext(), path);
		},
		/**
		 * Delete the confirmed paths as they are now. A recording is kept if
		 * new results appeared after confirmation.
		 */
		async delete(deletion: Deletion): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			// Work for the recording that is under way refuses now, rather than
			// queueing the deletion behind it.
			const recording =
				deletion.kind === 'recording'
					? deletion.id
					: deletion.kind === 'file'
						? deletion.recordingId
						: undefined;
			const busy = recording && deletionContext().busy(recording);
			if (busy) return busy;
			if (recording !== undefined) deleting.add(recording);
			try {
				return await runDeletion(
					{
						folder,
						dropFailed: runs.dropFailed,
						deleted: (path) => {
							if (!disposed) deleted(path);
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
		 * opened for a test, and stop pruning the selection; waits for nothing. A
		 * recording opening now is released when it answers. A recording
		 * under way is left to the page's departure: the shell finalizes and
		 * keeps a desktop recording, and a browser loses one in memory
		 * (ADR-0663). Its row was written at start; it gets no length. An
		 * answer whose file could not be written ends with the page, and its
		 * row stays unfinished.
		 */
		dispose,
	};
}

export type Whispering = ReturnType<typeof createWhispering>;
export const [getWhispering, setWhispering] = createContext<Whispering>();
