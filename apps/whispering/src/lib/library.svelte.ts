/**
 * The Whispering product state over one opened workspace.
 *
 * What the lists show is the folder as last read: the recording rows, their
 * transcription results, the transformations and their results, the settings
 * in `kv.json`, and the listing the file browser shows. They are read when
 * the page opens, after each of the app's own actions and terminal commands,
 * and when the person returns to the window. The latest read wins. Rows
 * that read are listed to edit; the rest are named, with why, for repair as
 * text.
 *
 * Open files are drafts (`drafts.svelte.ts`), each in its own edit session:
 * the selected recording or file with the recording's transcripts beside it,
 * and the selected transformation. Selecting another item leaves the drafts
 * it replaces: their saves land and their sessions are released. A draft
 * whose save failed or conflicted is left only when the person discards it
 * (`open` answers `unsaved`, and the view asks). Returning to the window
 * takes a newer version of an open draft that holds nothing unsaved;
 * otherwise its next save reports the change as a conflict.
 *
 * Three things live only in this window until they reach the folder: a draft
 * whose save failed, a captured recording whose audio and row are not both in
 * place, and text an endpoint returned whose file is not written yet
 * (`runs.svelte.ts`). In a browser tab each raises the leave warning; closing
 * the desktop app loses them.
 *
 * Git status comes from the folder's shared snapshot; this module adds no
 * status cache of its own. A save and its commit are separate outcomes.
 */
import type {
	CommitOutcome,
	FileCapture,
	FileListing,
	KvReading,
	RowReadError,
	StoredRow,
	TableListing,
} from '@epicenter/folder';
import { parseRow, rowPath, rowStemOf } from '@epicenter/folder';
import { ancestorsOf, dirname, joinPath } from '@epicenter/folder/file-browser';
import { createAdmissions } from '@epicenter/svelte/admissions';
import { customAlphabet } from 'nanoid';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActiveCapture, CapturedAudio } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	LegacyKeyTargets,
	Operation,
} from './connections.js';
import {
	audioPathIn,
	type LegacySettings,
	RECORDINGS,
	type RecordingFields,
	recordingAudioPath,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
	type TransformationRunFields,
	whisperingDefinition,
} from './definition.js';
import {
	captureDeletion,
	type Deletion,
	type DeletionContext,
	recordingTitle,
	removeDeletion,
} from './deletion.js';
import {
	createDrafts,
	type Draft,
	type DraftSession,
	RECORDING_GONE,
	rowTableOf,
	sessionOf,
} from './drafts.svelte.js';
import { describeError, nameProblem } from './files.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import {
	type InPlace,
	type PendingCapture,
	type PublishOutcome,
	publishRecording,
} from './recordings/publish.js';
import { createRuns } from './runs.svelte.js';
import { createTerminalSession } from './terminal.svelte.js';
import type { Workspace } from './workspace/index.js';

export type Library = ReturnType<typeof createLibrary>;
export type RecordingEntry = StoredRow<RecordingFields> & {
	readonly stem: string;
};
export type TranscriptionEntry = StoredRow<TranscriptionFields> & {
	readonly stem: string;
};
export type TransformationEntry = StoredRow<TransformationFields> & {
	readonly stem: string;
};
export type TransformationRunEntry = StoredRow<TransformationRunFields> & {
	readonly stem: string;
};
export type TextRunEntry = StoredRow<TextRunFields> & { readonly stem: string };
/** A row file that does not read as a row, and why, for the person to repair as text. */
export type Repair = {
	readonly path: string;
	readonly stem: string;
	readonly reason: string;
};

export type { Deletion } from './deletion.js';
export type { Draft, DraftSession } from './drafts.svelte.js';
export type {
	TextRun,
	TranscriptionRun,
	TransformationRun,
} from './runs.svelte.js';

/** What the recordings page shows: a recording, or any other file opened beside the recordings. */
export type Selection = {
	readonly kind: 'recording' | 'file';
	readonly path: string;
	readonly draft: Draft;
	/** The listed recording, for a recording. */
	readonly entry: RecordingEntry | undefined;
};

/**
 * A capture the window still holds: its fixed id and bytes, and where its
 * publication stands. The recording is not known to be in the folder, and
 * the bytes here are what would be lost. A published capture is dropped.
 */
export type PendingRecording = {
	readonly capture: PendingCapture;
	readonly mimeType: string;
	readonly attempts: number;
	readonly state:
		| { readonly kind: 'saving' }
		/** The last attempt stopped before the row was in place. */
		| Exclude<PublishOutcome, { kind: 'published' }>;
};

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

export type { InPlace };

const CLOSING = 'Whispering is closing, so nothing new was started.';
const RECORDING_NAME =
	'A recording’s file is named by its ID, which its transcription results refer to. Change the title instead.';
const RECORDING_AUDIO_NAME =
	'A recording names this audio file in its audioPath field, so renaming it here would leave that recording without audio. Change the recording’s title instead.';
const TRANSFORMATION_NAME =
	'A transformation’s file is named by its ID, which its saved results refer to. Change the title instead.';
const TRANSCRIPT_NAME = 'A transcript file keeps its .md extension.';
const STILL_TEXT =
	'Its text still does not read as a row. Fix what the notice names first.';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** A sortable id from the capture time: `20260102-030405-k3f9`. */
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

/** Why a listed row file does not read as a row, in the words the person is shown. */
export function repairReason(error: RowReadError): string {
	if (error.name === 'InvalidRow')
		return error.issues
			.map((issue) =>
				issue.line === undefined
					? issue.message
					: `Line ${issue.line}: ${issue.message}`,
			)
			.join(' ');
	if (error.name === 'InvalidUtf8') return 'It is not text.';
	return `It could not be read: ${error.message}`;
}

/** A listing's rows that read, and the rest with why. */
function split<TFields>(table: string, listed: TableListing<TFields>) {
	const entries: (StoredRow<TFields> & { stem: string })[] = [];
	const repairs: Repair[] = [];
	for (const { stem, result } of listed)
		if (result.error === null) entries.push({ ...result.data, stem });
		else
			repairs.push({
				path: rowPath(table, stem),
				stem,
				reason: repairReason(result.error),
			});
	return {
		entries,
		repairs,
		paths: listed.map(({ stem }) => rowPath(table, stem)),
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

export function createLibrary(workspace: Workspace) {
	const { folder } = workspace;
	const recordings = folder.tables.recordings;
	const transformations = folder.tables.transformations;

	/**
	 * Once set, no new work starts: a capture, a request, a retry, a file
	 * change, or input. Work accepted before stays accepted.
	 */
	let closing = $state(false);
	/** Work admitted and not finished; flushing and closing wait for it. */
	const admissions = createAdmissions();
	const { command } = admissions;

	/** Why nothing new starts now, if it does not. */
	function refused(): string | undefined {
		return closing ? CLOSING : undefined;
	}

	let entries = $state.raw<RecordingEntry[]>([]);
	let repairs = $state.raw<Repair[]>([]);
	let recordingPaths = $state.raw<ReadonlySet<string>>(new Set());
	let listError = $state<string | undefined>();
	let transcriptions = $state.raw<TranscriptionEntry[]>([]);
	let transformationEntries = $state.raw<TransformationEntry[]>([]);
	let transformationRepairs = $state.raw<Repair[]>([]);
	let transformationPaths = $state.raw<ReadonlySet<string>>(new Set());
	let transformationsError = $state<string | undefined>();
	let transformationResults = $state.raw<TransformationRunEntry[]>([]);
	let textResults = $state.raw<TextRunEntry[]>([]);
	let textRepairs = $state.raw<Repair[]>([]);
	let textResultsError = $state<string | undefined>();
	let listing = $state.raw<FileListing | undefined>();
	let listingError = $state<string | undefined>();
	let kv = $state.raw<KvReading<LegacySettings> | undefined>();
	let settingsError = $state<string | undefined>();
	/** What the device has set up, never a key; undefined until read or when the read failed. */
	let connections = $state.raw<ConnectionsInfo | undefined>();
	let connectionsError = $state<string | undefined>();
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));

	let selectedPath = $state<string | undefined>();
	let selectedTransformationPath = $state<string | undefined>();

	let pending = $state.raw<PendingRecording[]>([]);
	let recorder = $state.raw<RecorderState>({ phase: 'idle' });
	/**
	 * Change the recorder, and tell the desktop shell when a recording starts
	 * or ends, so a quit during one asks first.
	 */
	function setRecorder(next: RecorderState) {
		const was = recorder.phase !== 'idle';
		recorder = next;
		const is = next.phase !== 'idle';
		if (was !== is) workspace.setRecording?.(is);
	}
	let recorderError = $state<string | undefined>();
	let active: ActiveCapture | undefined;
	/** The start that has not answered yet. Aborting it releases a microphone that opens late. */
	let starting: AbortController | undefined;
	/** How many folder reads are under way. */
	let reading = $state(0);
	let refreshSequence = 0;
	/** Counts completed folder reads; audio players recheck their file on each. */
	let generation = $state(0);
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	/** Told the recording files a listing found, each time one is read. */
	const recordingsListed = new Set<(present: ReadonlySet<string>) => void>();

	const drafts = createDrafts(folder, {
		locked: () => closing,
		sizeOf: (path) =>
			listing?.files.find((file) => file.path === path)?.size ?? 0,
	});

	function resolve(recipe: RecipeRow | undefined): ResolvedRecipe {
		return resolveRecipe(recipe, connections?.text, connectionsError);
	}

	/** Wait for an open draft's saves; why not, when its save failed. */
	async function settle(path: string): Promise<string | undefined> {
		const session = sessionOf(drafts.get(path));
		if (session === undefined) return undefined;
		const settled = await session.settled();
		return settled.status === 'error'
			? `${path} has edits that are not saved. Resolve them in its file, then try again.`
			: undefined;
	}

	const runs = createRuns({
		workspace,
		makeId: recordingId,
		refused,
		connections: () => ({ info: connections, error: connectionsError }),
		resolve,
		settle,
		deleting,
		refresh: refreshAll,
		track: admissions.admit,
	});

	async function readConnections() {
		try {
			connections = await workspace.connections.read();
			connectionsError = undefined;
		} catch (cause) {
			connections = undefined;
			connectionsError = describe(cause);
		}
	}

	const terminal = createTerminalSession(
		{
			get cwd() {
				return workspace.terminal.cwd;
			},
			exec: (command, options) =>
				refused() === undefined
					? admissions.admit(() => workspace.terminal.exec(command, options))
					: Promise.reject(new Error(CLOSING)),
		},
		refreshAll,
	);
	const input = createMicrophoneInput({
		capture: workspace.capture,
		preferences: workspace.preferences,
		recording: () => recorder.phase !== 'idle',
	});

	/** One read of the folder. A read that a newer one overtook, or that answers after close began, changes nothing. */
	async function refresh() {
		if (closing) return;
		const sequence = ++refreshSequence;
		reading += 1;
		try {
			const [
				listedRecordings,
				listedTranscriptions,
				listedTransformations,
				listedOutputs,
				listedTextOutputs,
				files,
				storedKv,
			] = await Promise.all([
				recordings.list(),
				folder.tables.transcriptions.list(),
				transformations.list(),
				folder.tables.transformation_runs.list(),
				folder.tables.text_runs.list(),
				folder.files.list(),
				folder.kv.get(),
			]);
			if (closing || sequence !== refreshSequence) return;
			// A listing that failed keeps the previous one shown and says why.
			if (listedRecordings.error !== null)
				listError = listedRecordings.error.message;
			else {
				listError = undefined;
				const read = split(RECORDINGS, listedRecordings.data);
				entries = read.entries.sort(
					(a, b) =>
						b.row.fields.recordedAt.localeCompare(a.row.fields.recordedAt) ||
						byPath(b, a),
				);
				repairs = read.repairs.sort(byPath);
				recordingPaths = new Set(read.paths);
				for (const listener of recordingsListed) listener(recordingPaths);
			}
			if (listedTranscriptions.error === null)
				transcriptions = split(
					TRANSCRIPTIONS,
					listedTranscriptions.data,
				).entries;
			if (listedTransformations.error !== null)
				transformationsError = listedTransformations.error.message;
			else {
				transformationsError = undefined;
				const read = split(TRANSFORMATIONS, listedTransformations.data);
				const key = (entry: TransformationEntry) =>
					entry.row.fields.title || entry.path;
				transformationEntries = read.entries.sort(
					(a, b) =>
						key(a).localeCompare(key(b), undefined, { sensitivity: 'base' }) ||
						byPath(a, b),
				);
				transformationRepairs = read.repairs.sort(byPath);
				transformationPaths = new Set(read.paths);
			}
			if (listedOutputs.error === null)
				transformationResults = split(
					'transformation_runs',
					listedOutputs.data,
				).entries;
			if (listedTextOutputs.error !== null)
				textResultsError = listedTextOutputs.error.message;
			else {
				textResultsError = undefined;
				const read = split('text_runs', listedTextOutputs.data);
				textResults = read.entries;
				textRepairs = read.repairs;
			}
			if (files.error !== null) listingError = files.error.message;
			else {
				listingError = undefined;
				listing = files.data;
			}
			if (storedKv.error !== null) settingsError = storedKv.error.message;
			else {
				settingsError = undefined;
				kv = storedKv.data;
			}
			generation += 1;
		} finally {
			reading -= 1;
		}
	}

	async function refreshAll() {
		await Promise.all([refresh(), folder.git.status()]);
	}

	/** The listings, Git status, and a newer version of each open draft that holds nothing unsaved. */
	async function check() {
		if (closing) return;
		await Promise.all([refreshAll(), drafts.adopt()]);
	}

	/** Which pane a draft belongs to: the selected transformation's, or the recordings'. */
	const paneOf = (path: string) =>
		path === selectedTransformationPath ? 'transformations' : 'recordings';

	/**
	 * Show `path`: a transformation on its page, anything else beside the
	 * recordings. The drafts it replaces in that pane are left first: their
	 * saves land and the listings are read again. Answers the session that
	 * holds a draft it could not save, opening nothing; the view asks the
	 * person, and `discard` names the session whose draft they chose to let
	 * go. A newer open of the same pane, which leaves the same drafts, takes
	 * over, and this one opens nothing.
	 */
	async function open(
		path: string,
		{ discard }: { discard?: DraftSession } = {},
	): Promise<{ readonly unsaved: DraftSession } | undefined> {
		if (closing) return undefined;
		const pane =
			rowTableOf(path) === TRANSFORMATIONS ? 'transformations' : 'recordings';
		let left = false;
		for (const other of drafts.keys()) {
			if (other === path || paneOf(other) !== pane) continue;
			const leaving = await drafts.slot(other).leave({ discard });
			if (leaving.kind === 'unsaved') return { unsaved: leaving.session };
			if (leaving.kind === 'superseded') return undefined;
			left ||= leaving.left;
		}
		if (left) void refresh();
		if (closing) return undefined;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (pane === 'transformations') selectedTransformationPath = path;
		else selectedPath = path;
		await drafts.show(path);
		return undefined;
	}

	/** The open draft whose session is `session`. */
	function draftWith(session: DraftSession): Draft | undefined {
		const path = drafts.holding(session);
		return path === undefined ? undefined : drafts.get(path);
	}

	/**
	 * Recording sessions whose Keep mine found the file deleted. Their
	 * sessions refuse to create it again (`drafts.svelte.ts`), so only
	 * Discard is offered from then on.
	 */
	const gone = new SvelteSet<DraftSession>();

	/** Whether a recording row's file is known to be gone: its audio may be gone too, so it is not recreated. */
	function recordingGone(session: DraftSession) {
		const draft = draftWith(session);
		if (draft?.kind !== 'row' || draft.table !== RECORDINGS) return false;
		if (gone.has(session)) return true;
		const { state } = session;
		return (
			state.status === 'error' &&
			state.error.name === 'Conflict' &&
			state.error.actualSha256 === undefined
		);
	}

	/** Whether anything is held only in this window. */
	function holdsUnsavedWork(): boolean {
		return (
			recorder.phase !== 'idle' ||
			pending.length > 0 ||
			runs.holds() ||
			drafts
				.sessions()
				.some(
					({ state }) => state.status === 'saving' || state.status === 'error',
				)
		);
	}

	// --- recording ----------------------------------------------------------

	function setPending(id: string, next: PendingRecording | undefined) {
		pending =
			next === undefined
				? pending.filter((item) => item.capture.id !== id)
				: pending.some((item) => item.capture.id === id)
					? pending.map((item) => (item.capture.id === id ? next : item))
					: [next, ...pending];
	}

	/**
	 * One publication attempt for a pending capture. Its id and bytes never
	 * change. The first attempt writes; one the person asks for reads the
	 * folder first and finishes only what is missing. A confirmed publication
	 * drops the capture, and the recording opens unless the person selected
	 * something else meanwhile.
	 */
	async function publish(item: PendingRecording) {
		const attempt: PendingRecording = {
			...item,
			attempts: item.attempts + 1,
			state: { kind: 'saving' },
		};
		setPending(item.capture.id, attempt);
		const selectionBefore = selectedPath;
		const outcome = await publishRecording(folder, item.capture, {
			retry: item.attempts > 0,
			around: workspace.injection?.aroundRecordingWrite,
		});
		if (outcome.kind === 'published') {
			setPending(item.capture.id, undefined);
			await refreshAll();
			if (selectedPath === selectionBefore)
				await open(rowPath(RECORDINGS, item.capture.id));
			return;
		}
		setPending(item.capture.id, { ...attempt, state: outcome });
		// The audio may have landed before the attempt stopped; show what is there now.
		await refreshAll();
	}

	function accept(audio: CapturedAudio, endedAt: Date): PendingRecording {
		const id = recordingId(endedAt);
		const item: PendingRecording = {
			// Fixed here, once: every attempt publishes this id, these bytes, and
			// these fields, and the row names the audio's path itself.
			capture: {
				id,
				bytes: audio.bytes,
				fields: {
					title: defaultTitle(endedAt),
					recordedAt: endedAt.toISOString(),
					durationMs: audio.durationMs,
					capture: audio.source,
					audioPath: recordingAudioPath(id, audio.extension),
				} as RecordingFields,
				body: '',
			},
			mimeType: audio.mimeType,
			attempts: 0,
			state: { kind: 'saving' },
		};
		setPending(id, item);
		return item;
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		drafts,
		listing,
		busy: (id) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
		audioOf: (path) => {
			const entry = entries.find(
				(item) => audioPathIn(item.row.fields) === path,
			);
			return entry && recordingTitle(entry);
		},
	});

	return {
		workspace,
		folder,
		terminal,
		/** The microphone the next recording uses, and the test of it. */
		input,
		/** Whether the folder is being read now; the lists show the last read until it ends. */
		get refreshing() {
			return reading > 0;
		},
		/** Recordings that read, newest first. */
		get entries() {
			return entries;
		},
		/** Recording files that do not read as recordings, with why. */
		get repairs() {
			return repairs;
		},
		get transcriptions() {
			return transcriptions;
		},
		get listError() {
			return listError;
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			return listing;
		},
		get listingError() {
			return listingError;
		},
		expanded,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/**
		 * The transcription endpoint and model an earlier build saved in
		 * `kv.json`. Offered when the transcription connection is set up; never
		 * written, and never where a request goes.
		 */
		get legacySettings(): Partial<LegacySettings> {
			return kv?.values ?? {};
		},
		/** Why `kv.json` could not be read, or what in it does not conform. */
		get settingsProblem() {
			if (settingsError !== undefined) return settingsError;
			if (kv === undefined) return undefined;
			if (kv.issues.length === 0) return undefined;
			return kv.issues.map((issue) => issue.message).join('; ');
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
		 * itself all use. Undefined is a recipe whose text is not a valid row.
		 */
		resolve,
		get selectedPath() {
			return selectedPath;
		},
		/** What the recordings page shows: the selected path's draft. */
		get selection(): Selection | undefined {
			const path = selectedPath;
			const draft = path === undefined ? undefined : drafts.get(path);
			if (path === undefined || draft === undefined) return undefined;
			const recording = rowTableOf(path) === RECORDINGS;
			return {
				kind: recording ? 'recording' : 'file',
				path,
				draft,
				entry: recording
					? entries.find((entry) => entry.path === path)
					: undefined,
			};
		},
		/** The open draft at `path`. */
		draftAt(path: string): Draft | undefined {
			return drafts.get(path);
		},
		/**
		 * Open a transcript of the selected recording beside it. Nothing is
		 * selected; it is left with the recording.
		 */
		async openTranscript(path: string) {
			if (closing || rowStemOf(TRANSCRIPTIONS, path) === undefined) return;
			await drafts.show(path);
		},
		get closing() {
			return closing;
		},
		/** Hear which recording files each successful listing found. */
		onRecordingsListed(
			listener: (present: ReadonlySet<string>) => void,
		): () => void {
			recordingsListed.add(listener);
			return () => recordingsListed.delete(listener);
		},
		get pending() {
			return pending;
		},
		get recorder() {
			return recorder;
		},
		get recorderError() {
			return recorderError;
		},
		/** Whether `path` is a recording file, whether or not it reads as one. */
		isRecording(path: string) {
			return recordingPaths.has(path);
		},
		/** Saved transcripts of one recording, newest first. */
		resultsFor(id: string): TranscriptionEntry[] {
			return byNewest(
				transcriptions.filter((entry) => entry.row.fields.recordingId === id),
			);
		},
		transcriptionRun: runs.transcriptionRun,
		get unsavedTranscripts() {
			return runs.unsavedTranscripts;
		},
		/** Transformations that read, by title. */
		get transformations() {
			return transformationEntries;
		},
		get transformationsError() {
			return transformationsError;
		},
		/** Transformation files that do not read as transformations, with why. */
		get transformationRepairs() {
			return transformationRepairs;
		},
		isTransformation(path: string) {
			return transformationPaths.has(path);
		},
		get selectedTransformationPath() {
			return selectedTransformationPath;
		},
		/** The transformation being edited, with its listed row when it reads. */
		get selectedTransformation() {
			const path = selectedTransformationPath;
			const draft = path === undefined ? undefined : drafts.get(path);
			if (path === undefined || draft === undefined) return undefined;
			return {
				path,
				draft,
				entry: transformationEntries.find((entry) => entry.path === path),
			};
		},
		get transformationResults() {
			return byNewest(transformationResults);
		},
		/** Saved results made from one transcription, newest first. */
		outputsFor(transcriptionId: string): TransformationRunEntry[] {
			return byNewest(
				transformationResults.filter(
					(entry) => entry.row.fields.transcriptionId === transcriptionId,
				),
			);
		},
		/** Saved results one transformation produced, newest first. They outlive it. */
		outputsOf(transformationId: string): TransformationRunEntry[] {
			return byNewest(
				transformationResults.filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		get transformationRuns() {
			return runs.transformationRuns;
		},
		get unsavedTransformations() {
			return runs.unsavedTransformations;
		},
		get textRuns() {
			return runs.textRuns;
		},
		get unsavedTextResults() {
			return runs.unsavedTextResults;
		},
		/** Saved results on pasted text one recipe produced, newest first. */
		textOutputsOf(transformationId: string): TextRunEntry[] {
			return byNewest(
				textResults.filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		get textResultsError() {
			return textResultsError;
		},
		/** Files in `text_runs/` that do not read as results. */
		get textRepairs() {
			return textRepairs;
		},
		isRetrying: runs.isRetrying,
		/** Rises once per completed folder read. */
		get generation() {
			return generation;
		},
		get unsavedResults() {
			return runs.unsavedResults;
		},
		get saving() {
			return drafts
				.sessions()
				.some((session) => session.state.status === 'saving');
		},
		/** Open drafts whose save failed or conflicted. */
		get saveProblems() {
			return drafts
				.sessions()
				.filter((session) => session.state.status === 'error').length;
		},
		/** Whether leaving now would lose a draft, captured audio, a received answer, or a live recording. */
		get holdsUnsavedWork() {
			return holdsUnsavedWork();
		},
		/**
		 * Send each open draft's held snapshot and wait for the work in flight:
		 * admitted commands and every draft's saves. Starts nothing new and
		 * retries nothing, so a save that failed stays failed. The page's close
		 * runs this within a bound.
		 */
		async flush(): Promise<void> {
			await admissions.quiet();
			await Promise.all(drafts.sessions().map((session) => session.settled()));
		},
		refresh,
		refreshAll,
		/** The person's "Check again", and returning to the window. */
		check,
		open: command(open),
		/**
		 * First read after opening: the folder, then what this device has set
		 * up. Nothing is created and nothing is sent.
		 */
		async start() {
			await refreshAll();
			await readConnections();
			// The saved choice only: no microphone is opened or listed at launch.
			await input.load();
		},
		/** Edit a row file's whole text instead of its fields. Answers why not. */
		editSource: command(async (path: string): Promise<string | undefined> => {
			const why = refused();
			if (why !== undefined) return why;
			const unsaved = await drafts.reopen(path, 'text');
			return unsaved === undefined
				? undefined
				: 'Its last save did not finish. Resolve that first.';
		}),
		/**
		 * Edit a row file's fields again after editing its text. Text that is
		 * still not a valid row stays as text, and this says so.
		 */
		useForm: command(async (path: string): Promise<string | undefined> => {
			const why = refused();
			if (why !== undefined) return why;
			const draft = drafts.get(path);
			if (
				draft?.kind === 'text' &&
				draft.table !== undefined &&
				parseRow(whisperingDefinition.tables[draft.table], draft.session.draft)
					.error !== null
			)
				return STILL_TEXT;
			const unsaved = await drafts.reopen(path, 'row');
			if (unsaved !== undefined)
				return 'Its last save did not finish. Resolve that first.';
			// Changed elsewhere since: it reads as text again.
			return drafts.get(path)?.kind === 'text' ? STILL_TEXT : undefined;
		}),
		/**
		 * Reload theirs for `session`: show the file as it is now. A row whose
		 * text is no longer valid opens as text, a file that is no longer text
		 * opens as what it is, and a file that is gone closes. Answers what the
		 * person is told, if anything.
		 */
		reloadTheirs: command(
			async (session: DraftSession): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const reloaded = await drafts.reloadTheirs(session);
				if (reloaded === undefined) return undefined;
				if (reloaded.error !== null) return describeError(reloaded.error);
				await refresh();
				return undefined;
			},
		),
		/**
		 * Keep mine for `session`: save the draft over the file, or create it
		 * again. A recording deleted elsewhere is not created again, since its
		 * audio may be gone too.
		 */
		keepMine: command(
			async (session: DraftSession): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				// A recording's session refuses to create its file again; see `drafts.svelte.ts`.
				const kept = await drafts.keepMine(session);
				if (kept === undefined) return undefined;
				if (kept.error?.name === RECORDING_GONE.name) gone.add(session);
				await refresh();
				return kept.error === null ? undefined : describeError(kept.error);
			},
		),
		/** Whether Keep mine is offered for `session`: not for a recording known to be deleted elsewhere. */
		canKeepMine(session: DraftSession) {
			return !recordingGone(session);
		},
		/** Discard `session`'s draft and close it. Nothing is written. */
		discard(session: DraftSession) {
			const path = drafts.holding(session);
			if (path !== undefined) drafts.slot(path).forget(session);
		},

		async startRecording() {
			if (recorder.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			setRecorder({ phase: 'starting' });
			// A test or a pending enable holds the microphone: release it before the recording opens one.
			input.release();
			const attempt = new AbortController();
			starting = attempt;
			const { data: recording, error: startError } =
				await workspace.capture.start({
					input: input.choice,
					signal: attempt.signal,
				});
			// Cancelled or closed while the microphone was opening: it is not kept.
			if (starting !== attempt) {
				if (startError === null) recording.cancel();
				return;
			}
			starting = undefined;
			if (startError !== null) {
				setRecorder({ phase: 'idle' });
				recorderError = startError.message;
				input.noteRecordingError(startError);
				return;
			}
			active = recording;
			setRecorder({ phase: 'recording', startedAt: recording.startedAt });
		},
		/**
		 * Stop, keep the audio in this window, and publish it to the folder.
		 * While new work is not admitted the recording stays as it is.
		 */
		stopRecording: command(async () => {
			if (recorder.phase !== 'recording' || active === undefined) return;
			if (closing) return;
			const capture = active;
			active = undefined;
			setRecorder({ phase: 'stopping' });
			const { data: captured, error: stopError } = await capture.stop();
			setRecorder({ phase: 'idle' });
			if (stopError !== null) {
				recorderError = stopError.message;
				return;
			}
			await publish(accept(captured, new Date()));
		}),
		cancelRecording() {
			starting?.abort();
			starting = undefined;
			active?.cancel();
			active = undefined;
			setRecorder({ phase: 'idle' });
		},
		/** Publish a held capture again, under the same id and with the same bytes. */
		retryPending: command(async (id: string) => {
			if (closing) return;
			const item = pending.find((candidate) => candidate.capture.id === id);
			if (item === undefined || item.state.kind === 'saving') return;
			await publish(item);
		}),
		/** Drop a held capture. Files already in the folder are left as they are. */
		discardPending(id: string) {
			setPending(id, undefined);
		},
		/** The recording whose row names `path` as its audio, if one does. */
		recordingNaming(path: string): RecordingEntry | undefined {
			return entries.find((entry) => audioPathIn(entry.row.fields) === path);
		},

		transcribe: runs.transcribe,
		retrySaveResult: runs.retrySaveResult,
		dismissRun: runs.dismissRun,
		transform: runs.transform,
		transformText: runs.transformText,
		saveTextRun: runs.saveTextRun,
		retryTransformation: runs.retryTransformation,
		discardTransformationRun: runs.discardTransformationRun,

		/**
		 * A new recipe file: a title and instructions. It names no endpoint and
		 * no model of its own (`null`), so it runs with the text connection.
		 */
		createTransformation: command(
			async ({
				title,
				prompt,
			}: {
				title: string;
				prompt: string;
			}): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const { data: created, error } = await transformations.create({
					fields: { title, model: null, endpoint: null },
					body: prompt,
				});
				if (error !== null) return describeError(error);
				await refreshAll();
				await open(created.path);
				return undefined;
			},
		),
		deleteTransformationResult: command(
			async (entry: TransformationRunEntry): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const { error } = await folder.tables.transformation_runs.delete(entry);
				await refreshAll();
				return error === null ? undefined : describeError(error);
			},
		),
		deleteTextResult: command(
			async (entry: TextRunEntry): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const { error } = await folder.tables.text_runs.delete(entry);
				await refreshAll();
				return error === null ? undefined : describeError(error);
			},
		),

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to the folder.
		 */
		async saveConnection(
			operation: Operation,
			change: ConnectionChange,
		): Promise<string | undefined> {
			if (closing) return CLOSING;
			const { data: saved, error } = await workspace.connections.set(
				operation,
				change,
			);
			if (error !== null) return error;
			connections = saved;
			connectionsError = undefined;
			return undefined;
		},
		/** Move the key an earlier build saved into the chosen connections. */
		async adoptLegacyKey(
			targets: LegacyKeyTargets,
		): Promise<string | undefined> {
			if (closing) return CLOSING;
			const { data: adopted, error } =
				await workspace.connections.adoptLegacyKey(targets);
			if (error !== null) return error;
			connections = adopted;
			connectionsError = undefined;
			return undefined;
		},
		/** Read the connections again, as after a failed read. */
		readConnections,

		/**
		 * Rename a file within its folder. Recording and transformation files
		 * keep their names, and so does audio a recording names. An open draft
		 * waits for its saves and moves what its last save confirmed; a closed
		 * file moves from what it holds now.
		 */
		rename: command(
			async (path: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const directory = dirname(path);
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const to = joinPath(directory, name);
				if (to === path) return undefined;
				if (rowStemOf(RECORDINGS, path) !== undefined) return RECORDING_NAME;
				if (rowStemOf(TRANSFORMATIONS, path) !== undefined)
					return TRANSFORMATION_NAME;
				if (entries.some((entry) => audioPathIn(entry.row.fields) === path))
					return RECORDING_AUDIO_NAME;
				const stem = rowStemOf(TRANSCRIPTIONS, path);
				const nextStem = rowStemOf(TRANSCRIPTIONS, to);
				const move = (file: FileCapture) =>
					stem !== undefined && nextStem !== undefined
						? folder.tables.transcriptions.rename(file, nextStem)
						: folder.files.move(file, to);
				const draft = drafts.get(path);
				const session = sessionOf(draft);
				let moved: Result<unknown, { name: string; message: string }>;
				if (draft?.kind === 'row' && nextStem === undefined)
					moved = Err({ name: 'Refused', message: TRANSCRIPT_NAME });
				else if (session !== undefined) {
					moved = await session.rename(move);
					if (moved.error === null) {
						drafts.move(path, to);
						if (selectedPath === path) selectedPath = to;
					}
				} else {
					const { data: read, error } = await folder.files.read(path);
					moved =
						error !== null
							? Err(error)
							: await move({ path: read.path, sha256: read.sha256 });
					if (moved.error === null && selectedPath === path) {
						drafts.forget(path);
						selectedPath = to;
						await drafts.show(to);
					}
				}
				await refreshAll();
				return moved.error === null ? undefined : describeError(moved.error);
			},
		),
		/** A new empty text file; it never replaces an existing one. */
		createFile: command(
			async (directory: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (listing?.directories.includes(path))
					return `"${name}" already exists here.`;
				const { error } = await folder.files.create(path, '');
				if (error !== null) return describeError(error);
				await refreshAll();
				const opened = await open(path);
				return opened === undefined
					? undefined
					: 'It was added, but the open file has changes that are not saved, so it stays open.';
			},
		),
		createFolder: command(
			async (directory: string, name: string): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return `"${name}" already exists here.`;
				const { error } = await folder.files.mkdir(path);
				if (error !== null) return describeError(error);
				if (directory !== '') expanded.add(directory);
				await refresh();
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Open drafts' saves land first. One whose save failed does not refuse:
		 * the deletion removes what was last saved, and its edits are discarded.
		 */
		deletionFor: command(
			async (path: string): Promise<Result<Deletion, string>> => {
				const why = refused();
				if (why !== undefined) return Err(why);
				return captureDeletion(deletionContext(), path);
			},
		),
		/** Delete exactly what was confirmed; a file that changed since is refused. */
		remove: command(async (deletion: Deletion): Promise<string | undefined> => {
			const why = refused();
			if (why !== undefined) return why;
			const problem = await removeDeletion(
				{ ...deletionContext(), deleting, dropFailed: runs.dropFailed },
				deletion,
			);
			if (selectedPath !== undefined && drafts.get(selectedPath) === undefined)
				selectedPath = undefined;
			if (
				selectedTransformationPath !== undefined &&
				drafts.get(selectedTransformationPath) === undefined
			)
				selectedTransformationPath = undefined;
			await refreshAll();
			return problem;
		}),
		/** Commit current saved files. */
		commit: command(async (): Promise<CommitOutcome> => {
			if (closing) return { status: 'blocked', reason: CLOSING };
			return folder.git.commit();
		}),
		/**
		 * Let running work and saves finish, then release the folder. A draft
		 * that could not save, and audio that could not be published, end with
		 * the page; a browser tab warns before it is left while either exists.
		 */
		async close() {
			closing = true;
			// The microphone first: nothing still being written may keep it open.
			input.close();
			starting?.abort();
			starting = undefined;
			active?.cancel();
			await admissions.quiet();
			await input.saved();
			await Promise.all(drafts.sessions().map((session) => session.settled()));
			for (const path of drafts.keys()) drafts.forget(path);
			recordingsListed.clear();
			await workspace.close();
		},
	};
}
