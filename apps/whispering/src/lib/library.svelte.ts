/**
 * The Whispering product state over one opened folder, kept in the local
 * folder context's TanStack Query cache (`@epicenter/svelte/folder`).
 *
 * The context owns row and file-list queries, generates each file key, and
 * refreshes changed paths. The app defines text and audio representations. The library observes the rows and the listing for as long as it
 * is open, so every page shows them. A change the folder reports makes the
 * rows and files it names stale, and the ones shown are read again. Rows that
 * read are listed to edit; the rest are named, with why, for repair as text.
 *
 * Typing is never lost to a reread. A row's fields and body typed in a view
 * go through the row's edit handle (`folder.tables.<table>.edit(stem)`); a
 * file's whole text typed in Source or Files goes through its text edit
 * handle (`folder.files.edit(path)`), and each of its failed saves is
 * reported. The folder holds both: each saves a second after the last
 * change, or when the view leaves it, as a change from what it started
 * from, and the folder merges it with whatever was saved meanwhile
 * (ADR-0632). A save that fails keeps what is typed and is reported.
 *
 * Every other action is tracked work closing waits for: a recording's row and
 * its length, a transcript or a result, create, rename, delete, and
 * settings. The library stops product work and finishes its final writes
 * before FolderApp closes Folder and its accepted file edits.
 *
 * A recording is in the folder from the moment it starts (ADR-0543): its row
 * is written then, naming its audio, and on the desktop the audio is written
 * as it is captured. Whether it is still running is this window's live
 * capture, never a field. A transcription or recipe run is in the folder
 * from its start too (ADR-0542): its result row is written before the request
 * goes out, and its body when the answer arrives (`runs.svelte.ts`).
 */

import { InstantString } from '@epicenter/definition';
import type { Row } from '@epicenter/folder';
import type {
	RowEdit,
	RowEditChange,
	RowPending,
} from '@epicenter/folder/edits';
import { ancestors, dirname, joinPath } from '@epicenter/folder/file-browser';
import type { RecordingFolder } from '@epicenter/recorder';
import { createRowEdit, createTextEdit } from '@epicenter/svelte/edits';
import {
	unsavedText,
	type WriteFailure,
} from '@epicenter/svelte/write-failure';
import {
	hashKey,
	type QueryFunctionContext,
	QueryObserver,
} from '@tanstack/query-core';
import { customAlphabet } from 'nanoid';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActiveCapture } from './capture.js';
import type {
	ConnectionChange,
	ConnectionsInfo,
	Operation,
} from './connections.js';
import {
	audioPathIn,
	RECORDINGS,
	type RecordingFields,
	recordingAudioStem,
	rowIdOf,
	rowPath,
	TEXT_RUNS,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
	type TransformationRunFields,
	type WhisperingTables,
} from './definition.js';
import {
	captureDeletion,
	type Deletion,
	type DeletionContext,
	recordingTitle,
	runDeletion,
} from './deletion.js';
import { textRead } from './file-reads.js';
import { describeError, listingOf, nameProblem, readBytes } from './files.js';
import type { WhisperingContext } from './folder.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { type RecordingAudio, recordingAudio } from './recording-audio.js';
import { createRuns } from './runs.svelte.js';
import type { WhisperingServices } from './platform/types.js';

export const STOPPED = 'Whispering stopped before it finished starting.';

export type Library = ReturnType<typeof createLibrary>;

/** A listing's query options, as the first read runs them. */
type QueryOptions = {
	queryKey: readonly unknown[];
	queryFn: (context: QueryFunctionContext) => Promise<unknown>;
};

/** The fields of each table, by its name. */
type FieldsOf = {
	recordings: RecordingFields;
	transcriptions: TranscriptionFields;
	transformations: TransformationFields;
	transformation_runs: TransformationRunFields;
	text_runs: TextRunFields;
};
export type TableName = keyof FieldsOf;
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
/** What a view's row binding (`library.rowView`) offers a field or body edit. */
export type RowView = {
	readonly path: string;
	readonly pending: RowPending | undefined;
	change(change: RowEditChange): ReturnType<RowEdit['change']>;
	save(): Promise<void>;
};
/** A view's binding of a file's exact text (`library.textView`). */
export type TextView = ReturnType<
	typeof createTextEdit<Uint8Array | undefined>
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

/**
 * What the person is told about a save of a file's text that failed, as the
 * shared failure toast shows it: the text, Save again, and Discard.
 */
export type WriteNotice = WriteFailure & { readonly kind: 'failed' };

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

const CLOSING = 'Whispering is closing, so nothing was changed.';
const UNSAVED =
	'Typing in this file did not save yet. Save or discard it first.';
const RECORDING_NAME =
	'A recording’s file is named by its ID, which its transcription results refer to. Change the title instead.';
const RECORDING_AUDIO_NAME =
	'A recording names this audio file in its audioPath field, so renaming it here would leave that recording without audio. Change the recording’s title instead.';
const TRANSFORMATION_NAME =
	'A transformation’s file is named by its ID, which its saved results refer to. Change the title instead.';
const TRANSCRIPT_NAME = 'A transcript file keeps its .md extension.';
const STILL_TEXT =
	'Its text still does not read as a row. Fix what the notice names first.';
const TAKEN = 'Another file already has this name, so nothing was changed.';

const suffix = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 4);

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/** Cache identity for the app's own actions. */
export const whisperingKeys = defineKeys({
	/** Every action the app runs. */
	all: ['whispering'],
	/** A recording's lifecycle: its row and length, and saving its transcripts and results. */
	recording: (path: string) => ['whispering', 'recording', path] as const,
	action: (name: string) => ['whispering', 'action', name] as const,
});

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

/** Why a listed row file does not read as a row, in the words the person is shown. */
export function repairReason(row: Pick<Row, 'issues'>): string {
	if (row.issues === null) return '';
	if (row.issues.some((issue) => issue.kind === 'not-text'))
		return 'It is not text.';
	return row.issues
		.map((issue) => {
			const [field] = issue.path;
			const what =
				field === undefined ? issue.message : `${field} ${issue.message}`;
			return issue.line === undefined ? what : `Line ${issue.line}: ${what}`;
		})
		.join(' ');
}

/** A listing's rows that read, and the rest with why. */
function split<T extends TableName>(table: T, rows: readonly ListedRow<T>[]) {
	const entries: Entry<T>[] = [];
	const repairs: Repair[] = [];
	for (const row of rows) {
		const path = rowPath(table, row.id);
		if (row.issues === null)
			entries.push({ stem: row.id, path, row: row as ReadRow<T> });
		else repairs.push({ path, stem: row.id, reason: repairReason(row) });
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

/** One derived value per listing the cache holds, computed once per listing. */
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

export function createLibrary(
	services: WhisperingServices,
	local: WhisperingContext,
) {
	const { folder } = local;
	const { queryClient } = local;
	const keys = whisperingKeys;
	const { defineMutation } = createQueryFactories(queryClient);

	const noticeListeners = new Set<(notice: WriteNotice) => void>();
	function notify(notice: WriteNotice) {
		for (const listener of noticeListeners) listener(notice);
	}

	/** Set by `stop`: nothing new starts from then on. Work accepted before finishes. */
	let fenced = $state(false);
	let stopping: Promise<void> | undefined;
	let captureNotice = $state<string | undefined>();
	/** Why nothing new starts now, if it does not. */
	const refused = () => (fenced ? CLOSING : undefined);
	/** Files being renamed or deleted: typing into them waits. */
	const busyPaths = new SvelteSet<string>();
	/** Work closing waits for. */
	const pending = new Set<Promise<unknown>>();
	function hold<T>(work: Promise<T>): Promise<T> {
		pending.add(work);
		const done = () => pending.delete(work);
		work.then(done, done);
		return work;
	}

	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe((event) => {
			if (
				event.type === 'added' ||
				event.type === 'removed' ||
				event.type === 'updated'
			)
				update();
		}),
	);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);

	// --- reads -----------------------------------------------------------------

	const rowsKey = (table: TableName) => local.queries.rows(table).queryKey;
	const filesQuery = local.queries.files();
	const filesKey = filesQuery.queryKey;
	const tables = [
		RECORDINGS,
		TRANSCRIPTIONS,
		TRANSFORMATIONS,
		TRANSFORMATION_RUNS,
		TEXT_RUNS,
	] as const;
	/** What the library observes while it is open: every table's rows and the files. */
	const shownQueries = (): QueryOptions[] => [
		...tables.map(
			(table) => local.queries.rows(table) as unknown as QueryOptions,
		),
		filesQuery,
	];
	const listingKeys = shownQueries().map((options) => options.queryKey);
	/** Stops observing what `start` began observing. */
	let stopObserving: (() => void)[] = [];

	/** A table's rows as the cache holds them, read reactively. */
	function listed<T extends TableName>(table: T) {
		trackQueries();
		return queryClient.getQueryData<ListedRow<T>[]>(rowsKey(table));
	}
	/** Why the last read of a query failed, read reactively. */
	function readError(queryKey: readonly unknown[]): string | undefined {
		trackQueries();
		return queryClient.getQueryState(queryKey)?.error?.message;
	}
	const listedFiles = perListing(listingOf);
	/** The folder's files as last listed, read reactively. */
	function listing() {
		trackQueries();
		const paths = queryClient.getQueryData<string[]>(filesKey);
		return paths === undefined ? undefined : listedFiles(paths);
	}
	const textData = (path: string) =>
		queryClient.getQueryData(local.queries.file(path, textRead).queryKey);

	const recordingsOf = perListing((rows: ListedRow<'recordings'>[]) => {
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
		(rows: ListedRow<'transformations'>[]) => {
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
		(rows: ListedRow<'transcriptions'>[]) =>
			split(TRANSCRIPTIONS, rows).entries,
	);
	const resultsOf = perListing(
		(rows: ListedRow<'transformation_runs'>[]) =>
			split(TRANSFORMATION_RUNS, rows).entries,
	);
	const textResultsOf = perListing((rows: ListedRow<'text_runs'>[]) =>
		split(TEXT_RUNS, rows),
	);

	const recordingsRead = () => {
		const rows = listed(RECORDINGS);
		return rows && recordingsOf(rows);
	};
	const entries = () => recordingsRead()?.entries ?? [];

	/** The row the cache holds for `stem`, whether or not it reads. */
	function listedRow<T extends TableName>(
		table: T,
		stem: string,
	): ListedRow<T> | undefined {
		return queryClient
			.getQueryData<ListedRow<T>[]>(rowsKey(table))
			?.find((row) => row.id === stem);
	}
	/** The row the cache holds for `stem`, if it reads. */
	function rowOf<T extends RowTable>(
		table: T,
		stem: string,
	): ReadRow<T> | undefined {
		const row = listedRow(table, stem);
		return row?.issues === null ? (row as ReadRow<T>) : undefined;
	}


	// --- drafts ----------------------------------------------------------------

	/**
	 * The whole-text edit of `path` over the bytes the cache holds when it
	 * opens as text, read reactively. The folder holds the text typed, saves
	 * it, and sends it when it settles or closes.
	 */
	const textAt = (path: string) =>
		createTextEdit(folder.files.edit(path), () => {
			const opened = textData(path);
			return opened?.kind === 'text' ? opened.bytes : undefined;
		});
	/** The text typed into `path` and not saved, read reactively. */
	function heldText(path: string) {
		const pending = textAt(path).pending;
		return pending?.kind === 'text' ? pending : undefined;
	}
	/** Whether text typed into `path` is held and not failed: saving or about to. */
	function writingText(path: string) {
		const held = heldText(path);
		return held !== undefined && (held.saving || held.error === undefined);
	}

	// Each save of a file's text that fails is told once, with the text to
	// copy, a retry and a discard. Typing over failed text tells nothing new.
	const savingText = new Set<string>();
	const stopTelling = folder.files.edit('').subscribe((path) => {
		if (path === undefined) return;
		const pending = folder.files.edit(path).pending;
		if (pending?.kind !== 'text') {
			savingText.delete(path);
			return;
		}
		if (pending.saving) {
			savingText.add(path);
			return;
		}
		if (!savingText.delete(path) || pending.error === undefined) return;
		notify({
			kind: 'failed',
			path,
			error: pending.error,
			unsaved: pending.text,
			retry: () => {
				if (fenced) return false;
				void folder.files.edit(path).retry();
				return true;
			},
			discard: () => {
				const discarded = folder.files.edit(path).discard();
				return discarded?.kind === 'text' ? discarded.text : undefined;
			},
		});
	});

	/** The edit handle of row `stem` of `table`. */
	const rowEdit = (table: RowTable, stem: string): RowEdit =>
		folder.tables[table].edit(stem) as RowEdit;
	/** The typing of `path`, read reactively, if it is a row this window edits. */
	function rowEditAt(path: string) {
		const table = rowTableOf(path);
		const stem = table === undefined ? undefined : rowIdOf(table, path);
		return table === undefined || stem === undefined
			? undefined
			: createRowEdit(rowEdit(table, stem), () => undefined);
	}

	/** Row files the person chose to edit as their exact text. */
	const asText = new SvelteSet<string>();

	/**
	 * Whether `path` shows as its exact text: a row file the person opened in
	 * Source, or one whose text does not read as a row.
	 */
	function showsText(path: string): boolean {
		if (heldText(path) !== undefined) return true;
		const table = rowTableOf(path);
		if (table === undefined) return true;
		if (asText.has(path)) return true;
		const stem = rowIdOf(table, path) as string;
		const row = listed(table)?.find((item) => item.id === stem);
		return row !== undefined && row.issues !== null;
	}

	/** Send the typing held for `path`, row or text; answers whether some still did not save. */
	async function settlePath(path: string): Promise<boolean> {
		const edit = rowEditAt(path);
		if (edit !== undefined) await edit.save();
		await folder.files.edit(path).save();
		return edit?.pending !== undefined || heldText(path) !== undefined;
	}

	/** After a rename: the caches and the selection follow the file. */
	function moved(from: string, to: string) {
		if (asText.delete(from)) asText.add(to);
		if (selectedPath === from) selectedPath = to;
	}

	/** After a delete: the caches and the selection let the file go. */
	function deleted(path: string) {
		for (const table of tables) {
			const stem = rowIdOf(table, path);
			if (stem !== undefined)
				queryClient.setQueryData<Row[]>(rowsKey(table), (rows) =>
					rows?.filter((row) => row.id !== stem),
				);
		}
		asText.delete(path);
		if (selectedPath === path) selectedPath = undefined;
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
	}

	/**
	 * Run `work` as a mutation, so closing waits for it. `scope` names the
	 * recording or file it is for; work with no scope only reads. What it
	 * saves reaches the views on the folder's change channel, so it ends
	 * when its own work does, never after a reread.
	 */
	async function track<T>(work: () => Promise<T>, scope?: string): Promise<T> {
		const ran = await hold(
			defineMutation({
				mutationKey:
					scope === undefined ? keys.action('read') : keys.recording(scope),
				mutationFn: async () => Ok(await work()),
			})(),
		);
		if (ran.error !== null) throw ran.error;
		return ran.data as T;
	}

	// --- connections, microphone -------------------------------------------------

	/** What the device has set up, never a key; undefined until read or when the read failed. */
	let connections = $state.raw<ConnectionsInfo | undefined>();
	let connectionsError = $state<string | undefined>();

	function resolve(recipe: RecipeRow | undefined): ResolvedRecipe {
		return resolveRecipe(recipe, connections?.text, connectionsError);
	}

	async function readConnections() {
		try {
			const read = await services.connections.read();
			if (fenced) return;
			connections = read;
			connectionsError = undefined;
		} catch (cause) {
			if (fenced) return;
			connections = undefined;
			connectionsError = describe(cause);
		}
	}

	let selectedPath = $state<string | undefined>();
	let selectedTransformationPath = $state<string | undefined>();

	let recorder = $state.raw<RecorderState>({ phase: 'idle' });
	let recorderError = $state<string | undefined>();
	/** The recording being captured: its row's stem and the live capture. */
	let active:
		| { readonly id: string; readonly capture: ActiveCapture }
		| undefined;
	/** The recording being captured, by stem. No request starts for it until it stops. */
	const capturing = new SvelteSet<string>();
	/**
	 * The save of each recording's row at its start, by stem, settled or not.
	 * Its length at stop and its deletion at cancel wait for it, so neither
	 * reads the folder before the row is there.
	 */
	const startRows = new Map<string, Promise<unknown>>();
	/**
	 * A recording this window just finished, by stem, with the file listing
	 * read when its capture ended. Until the folder is listed again, that
	 * listing may predate its audio, so the audio is not reported absent.
	 */
	const finishedOver = new Map<string, number>();
	/** The start that has not answered yet. Aborting it releases a microphone that opens late. */
	let starting: AbortController | undefined;
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	/** Told the recording files a listing found, each time one is read. */
	const recordingsListed = new Set<(present: ReadonlySet<string>) => void>();
	const recordingsHash = hashKey(rowsKey(RECORDINGS));
	const stopListening = queryClient.getQueryCache().subscribe((event) => {
		if (event.type !== 'updated' || event.action.type !== 'success') return;
		if (event.query.queryHash !== recordingsHash) return;
		const read = recordingsRead();
		if (read === undefined) return;
		for (const listener of recordingsListed) listener(read.paths);
	});

	const runs = createRuns({
		folder,
		transcribe: (request) => services.transcribe(request),
		transform: (request) => services.transform(request),
		makeId: recordingId,
		refused,
		connections: () => ({ info: connections, error: connectionsError }),
		resolve,
		settle: settlePath,
		deleting,
		capturing,
		track,
	});

	const input = createMicrophoneInput({
		capture: services.capture,
		preferences: services.preferences,
		recording: () => recorder.phase !== 'idle',
	});

	/** Show `path`: a transformation on its page, anything else beside the recordings. Opening never waits or asks. */
	function open(path: string) {
		if (fenced) return;
		for (const ancestor of ancestors(path)) expanded.add(ancestor);
		if (rowTableOf(path) === TRANSFORMATIONS) selectedTransformationPath = path;
		else selectedPath = path;
	}

	// --- recording ----------------------------------------------------------

	/**
	 * The write a browser capture places its audio through. On the desktop
	 * the shell records into the folder it bound to this window.
	 */
	const recordingFolder = (): RecordingFolder => ({
		write: folder.files.write,
	});

	/**
	 * Finish the recording being captured: its audio file is finalized and its
	 * length written to its row, which was written when it started. A row
	 * that cannot take its length keeps everything else, and says why.
	 */
	async function finishRecording() {
		if (active === undefined) return;
		const { id, capture } = active;
		active = undefined;
		recorder = { phase: 'stopping' };
		const path = rowPath(RECORDINGS, id);
		const selectionBefore = selectedPath;
		// In a browser, and for fixture audio, the audio file is written now; on
		// the desktop it was written as it was captured, and stop finishes it.
		// Started here, not when the mutation runs, so the microphone is let go
		// at once.
		const stopping = capture.stop();
		const { data: stopped, error: stopError } = await track(() => stopping);
		if (stopError === null)
			finishedOver.set(
				id,
				queryClient.getQueryState(filesKey)?.dataUpdateCount ?? 0,
			);
		capturing.delete(id);
		recorder = { phase: 'idle' };
		if (stopError !== null) {
			recorderError = stopError.message;
			return;
		}
		const lengthError = await track(async () => {
			await startRows.get(id);
			startRows.delete(id);
			const recordings = folder.tables.recordings;
			const { data: stored, error } = await recordings.get(id);
			if (error !== null) return describeError(error);
			// A row deleted meanwhile stays deleted.
			if (stored === undefined) return undefined;
			const { error: saveError } = await recordings.set(id, stored, {
				fields: { durationMs: stopped.durationMs },
			});
			return saveError === null ? undefined : describeError(saveError);
		}, path);
		if (lengthError !== undefined)
			recorderError = `The recording is saved, but its length could not be written: ${lengthError}`;
		if (selectedPath === selectionBefore) open(path);
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		deleteRow: (table, id) => folder.tables[table].edit(id).delete(),
		settle: settlePath,
		busy: (id) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
		audioOf: (path) => {
			const entry = entries().find(
				(item) => audioPathIn(item.row.fields) === path,
			);
			return entry && recordingTitle(entry);
		},
	});

	/**
	 * An action that does not start while closing; answers what the person
	 * is told. What it saves reaches the views on the folder's change
	 * channel; closing waits for its work, never for a reread.
	 */
	function action<TArgs extends unknown[]>(
		name: string,
		work: (...args: TArgs) => Promise<string | undefined>,
	) {
		const mutation = defineMutation({
			mutationKey: keys.action(name),
			mutationFn: async (args: TArgs) => Ok(await work(...args)),
		});
		return async (...args: TArgs): Promise<string | undefined> => {
			// Refused when asked; once accepted, it runs, and closing waits for it.
			const why = refused();
			if (why !== undefined) return why;
			const ran = await hold(local.run(() => mutation(args)));
			return ran.error === null ? (ran.data ?? undefined) : describe(ran.error);
		};
	}

	/** Whether `path` is taken by a file, or by a directory files are in, as last listed. */
	function taken(path: string) {
		const files = listing();
		return (
			files?.paths.has(path) === true ||
			files?.directories.includes(path) === true
		);
	}

	const saveConnection = action(
		'save-connection',
		async (operation: Operation, change: ConnectionChange) => {
			const { data: saved, error } = await services.connections.set(
				operation,
				change,
			);
			if (error !== null) return error;
			connections = saved;
			connectionsError = undefined;
			return undefined;
		},
	);

	/** Save a new recipe file `id`; it names no model of its own. */
	const createTransformation = action(
		'create-transformation',
		async (
			id: string,
			{ title, prompt }: { title: string; prompt: string },
		) => {
			const { error } = await folder.tables.transformations.set(id, null, {
				fields: { title, model: null },
				body: prompt,
			});
			return error === null ? undefined : describeError(error);
		},
	);

	/** Delete row `stem` of a result table as it is stored, after its typing saved. */
	function deleteResult(table: typeof TRANSFORMATION_RUNS | typeof TEXT_RUNS) {
		return async (entry: { readonly stem: string; readonly path: string }) => {
			const { data, error } = await folder.tables[table]
				.edit(entry.stem)
				.delete();
			if (error !== null) return describeError(error);
			if (!data.deleted) {
				// Kept because it changed, or already gone, here or elsewhere.
				const { data: still } = await folder.tables[table].get(entry.stem);
				if (still !== undefined)
					return `${entry.path} changed meanwhile, so it was kept.`;
			}
			deleted(entry.path);
			return undefined;
		};
	}

	return {
		services,
		/** The opened folder context and its query cache. */
		local,
		/** The microphone the next recording uses, and the test of it. */
		input,
		/** Whether a listing is being read now; the lists show the last read until it ends. */
		get refreshing() {
			trackQueries();
			return listingKeys.some(
				(queryKey) => queryClient.isFetching({ queryKey, exact: true }) > 0,
			);
		},
		/** Recordings that read, newest first. */
		get entries() {
			return entries();
		},
		/** Recording files that do not read as recordings, with why. */
		get repairs() {
			return recordingsRead()?.repairs ?? [];
		},
		get transcriptions() {
			const rows = listed(TRANSCRIPTIONS);
			return rows ? transcriptionsOf(rows) : [];
		},
		get listError() {
			return readError(rowsKey(RECORDINGS));
		},
		/** Every file in the folder, as last listed. */
		get listing() {
			return listing();
		},
		get listingError() {
			return readError(filesKey);
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
		/**
		 * What the recordings page shows. A missing recording stays selected
		 * while it holds input that has not saved.
		 */
		get selection(): Selection | undefined {
			const path = selectedPath;
			if (path === undefined) return undefined;
			if (rowTableOf(path) !== RECORDINGS)
				return { kind: 'file', path, entry: undefined };
			const read = recordingsRead();
			if (
				read !== undefined &&
				!read.paths.has(path) &&
				rowEditAt(path)?.pending === undefined &&
				heldText(path) === undefined
			)
				return undefined;
			return {
				kind: 'recording',
				path,
				entry: read?.entries.find((entry) => entry.path === path),
			};
		},
		get selectedTransformationPath() {
			return selectedTransformationPath;
		},
		/** The transformation being edited, with its listed row when it reads. */
		get selectedTransformation() {
			const path = selectedTransformationPath;
			if (path === undefined) return undefined;
			const rows = listed(TRANSFORMATIONS);
			const read = rows && transformationsOf(rows);
			if (
				read !== undefined &&
				!read.paths.has(path) &&
				rowEditAt(path)?.pending === undefined &&
				heldText(path) === undefined
			)
				return undefined;
			return {
				path,
				entry: read?.entries.find((entry) => entry.path === path),
			};
		},
		/** Show `path`: a transformation on its page, anything else beside the recordings. */
		async open(path: string): Promise<void> {
			open(path);
		},

		// ------------------------------------------------------------------
		// Drafts
		// ------------------------------------------------------------------

		/**
		 * The row of `table` at `path` as one view shows and types into it:
		 * `row`, read reactively, is the cache's row with own saves its read
		 * may not show yet and what is typed over it; `change` and the field
		 * edits of `fieldOf` and `setFields` name what this view last showed.
		 * A view makes one for its file and keeps it.
		 */
		rowView<T extends RowTable>(table: T, path: string) {
			const stem = rowIdOf(table, path) ?? '';
			return createRowEdit(rowEdit(table, stem), () => {
				trackQueries();
				return rowOf(table, stem);
			});
		},
		/** The fields and body typed into the row file at `path` and not saved, read reactively. */
		heldAt: (path: string) => rowEditAt(path)?.pending,
		/**
		 * The row of `table` at `path` as last read, whether or not it reads:
		 * its exact source and, when it does not read, its issues.
		 */
		rowSource<T extends RowTable>(
			table: T,
			path: string,
		): ListedRow<T> | undefined {
			const stem = rowIdOf(table, path);
			if (stem === undefined) return undefined;
			return listed(table)?.find((row) => row.id === stem);
		},
		/** The text typed into `path` that is not saved yet, read reactively. */
		editedText: (path: string): string | undefined => heldText(path)?.text,
		/** Whether `path` shows as its exact text rather than its fields. */
		showsText(path: string) {
			return showsText(path);
		},
		/**
		 * One field of the row a view shows (`view`, from `rowView`), as that
		 * view edits it: what is typed over the value shown, sent with the
		 * row's input, over what the view last showed.
		 */
		fieldOf<T extends RowTable, K extends keyof FieldsOf[T] & string>(
			view: RowView,
			name: K,
		) {
			type Value = FieldsOf[T][K];
			const typed = (): { value: Value } | undefined => {
				const fields: Record<string, unknown> | undefined =
					view.pending?.fields;
				return fields !== undefined && Object.hasOwn(fields, name)
					? { value: fields[name] as Value }
					: undefined;
			};
			return {
				/** `value` with what is typed over it. */
				shown: (value: Value): Value => {
					const held = typed();
					return held === undefined ? value : held.value;
				},
				/** What is typed and not saved, or undefined when nothing is. */
				get typed(): Value | undefined {
					return typed()?.value;
				},
				/** Type `value`; it saves after a pause. */
				change(value: Value) {
					view.change({ fields: { [name]: value } });
				},
				/** Save what is typed now. */
				save: () => view.save(),
				get error() {
					return view.pending?.error;
				},
				get saving() {
					return view.pending?.saving ?? false;
				},
			};
		},
		/** Whether the row file at `path` takes an edit now: not closing, renamed, or deleted. */
		canEdit: (path: string) =>
			!fenced && !busyPaths.has(path) && !(rowEditAt(path)?.locked ?? false),
		/**
		 * Set fields of the row a view shows at once, over what it last
		 * showed, merged with whatever was saved meanwhile. Refused, changing
		 * nothing, while closing, and while a rename or delete of the file
		 * runs. Inputs commit only values the schema accepts.
		 */
		setFields<T extends RowTable>(
			view: RowView,
			set: Partial<FieldsOf[T]>,
		): void {
			if (fenced || busyPaths.has(view.path)) return;
			if (view.change({ fields: set }).error === null) void view.save();
		},
		/**
		 * Type `body` as the body of the row a view shows, over what it last
		 * showed; it saves a second after the last change, or at once with
		 * `saveBody`, merged with whatever changed since.
		 */
		editBody(view: RowView, body: string): void {
			if (fenced || busyPaths.has(view.path)) return;
			view.change({ body });
		},
		/** Send what is typed into the row at `path` now, as leaving it does. */
		saveBody: (path: string) => rowEditAt(path)?.save() ?? Promise.resolve(),
		/**
		 * The exact text of `path` as one view shows and types it, over the
		 * bytes `observed` answers, the view's own read of the file: held
		 * text, else those bytes with own saves its read may not show yet.
		 * Typing (`editText`) names what the view last showed and saves a
		 * second after the last change, or at once with `saveText`.
		 */
		textView: (path: string, observed: () => Uint8Array | undefined) =>
			createTextEdit(folder.files.edit(path), observed),
		/** Type `text` as the whole text a view shows, over what it last showed. */
		editText(view: TextView, text: string): void {
			if (fenced || busyPaths.has(view.path)) return;
			view.change(text);
		},
		/** Save the text typed into `path` now, as leaving it does; resolves once no save of it runs. */
		saveText: (path: string) => folder.files.edit(path).save(),
		/** Hear each save of a file's text that failed, which the person is told. */
		onWriteNotice(listener: (notice: WriteNotice) => void): () => void {
			noticeListeners.add(listener);
			return () => noticeListeners.delete(listener);
		},
		/** Whether a save of `path` runs or waits, or typing there waits to be sent; read reactively. */
		isSaving(path: string) {
			if (busyPaths.has(path) || writingText(path)) return true;
			const held = rowEditAt(path)?.pending;
			return held !== undefined && (held.saving || held.error === undefined);
		},
		/** Whether typing at `path` did not save, with no save running; read reactively. */
		isUnsaved(path: string) {
			const text = heldText(path);
			if (text?.error !== undefined && !text.saving) return true;
			const held = rowEditAt(path)?.pending;
			return held?.error !== undefined && !held.saving;
		},
		/** Save again what is typed into `path` and did not save: its fields, body, or text. */
		retry: async (path: string) => {
			await rowEditAt(path)?.retry();
			await folder.files.edit(path).retry();
		},
		/**
		 * Let go of what is typed into `path` and did not save, leaving the file
		 * as it is. Answers what was let go, for the person to copy, or
		 * undefined when nothing was held or a save of it is running.
		 */
		discard(path: string): string | undefined {
			const discarded =
				folder.files.edit(path).discard() ?? rowEditAt(path)?.discard();
			if (discarded === undefined) return undefined;
			// A body alone stays plain text for copying back into its control.
			if (
				discarded.kind === 'row' &&
				Object.keys(discarded.fields).length === 0
			)
				return discarded.body;
			return unsavedText(discarded);
		},
		/** Whether a save runs, or typing waits to be sent; read reactively. */
		get saving() {
			return local.saveState === 'saving';
		},
		/** Whether typing did not save, here or in a file's text; read reactively. */
		get unsaved() {
			return local.saveState === 'failed';
		},
		/** Why the last save failed in storage, until a save lands; read reactively. */
		get storageFailure(): string | undefined {
			const failure = local.status.storageFailure;
			return failure === null ? undefined : describeError(failure);
		},
		/**
		 * Whether leaving the page now could lose something: typing held, a
		 * save running, or work under way; read reactively.
		 */
		get busy() {
			trackMutations();
			return local.busy || queryClient.isMutating() > 0;
		},
		/** Whether input is refused now: while closing, or while `path` is renamed or deleted. */
		locked: (path?: string) =>
			path === undefined
				? fenced
				: fenced || busyPaths.has(path) || (rowEditAt(path)?.locked ?? false),
		/**
		 * Edit a row file's whole text instead of its fields. What is typed into
		 * its fields saves first, and its text is read then. Typing that did not
		 * save refuses the switch, so the file never has two edits at once.
		 * Answers why not.
		 */
		async editSource(path: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const edit = rowEditAt(path);
			if (edit !== undefined) {
				await edit.save();
				if (edit.pending !== undefined) return UNSAVED;
			}
			await queryClient
				.fetchQuery({ ...local.queries.file(path, textRead), staleTime: 0 })
				.catch(() => undefined);
			asText.add(path);
			return undefined;
		},
		/**
		 * Edit a row file's fields again after editing its text. Its text saves,
		 * and its row is read then. Text that does not read as a row stays as
		 * text, and this says so; so does text whose save failed, until it
		 * saves or is discarded.
		 */
		async useForm(path: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const table = rowTableOf(path);
			if (table === undefined) return undefined;
			await folder.files.edit(path).save();
			if (heldText(path) !== undefined) return UNSAVED;
			await queryClient
				.fetchQuery({ ...local.queries.rows(table), staleTime: 0 })
				.catch(() => undefined);
			const stem = rowIdOf(table, path);
			const row = listed(table)?.find((item) => item.id === stem);
			if (row !== undefined && row.issues !== null) return STILL_TEXT;
			asText.delete(path);
			return undefined;
		},

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		get closing() {
			return fenced;
		},
		/** Hear which recording files each successful listing found. */
		onRecordingsListed(
			listener: (present: ReadonlySet<string>) => void,
		): () => void {
			recordingsListed.add(listener);
			return () => recordingsListed.delete(listener);
		},

		// ------------------------------------------------------------------
		// Reads on request
		// ------------------------------------------------------------------

		/**
		 * Read the folder again at `paths`, or all of it, as after a read that
		 * failed, or before a step that goes by what is listed now.
		 */
		async readAgain(paths?: readonly string[]) {
			if (fenced) return;
			await local.refresh(paths);
		},
		/** Why recordings cut off by a quit or crash could not be checked. */
		get captureNotice() {
			return captureNotice;
		},
		/** Repair interrupted recordings before the first folder and device reads. */
		async start() {
			if (fenced) throw new Error(STOPPED);
			const notice = await local.run(() => services.recoverRecordings());
			if (fenced) throw new Error(STOPPED);
			captureNotice = notice;
			// A read that answers with an error is shown as that listing's
			// problem; one that throws means the folder cannot be read at all,
			// and the opening fails with it.
			const thrown: unknown[] = [];
			await Promise.all(
				shownQueries().map((options) =>
					queryClient
						.fetchQuery({
							...options,
							queryFn: async (context) => {
								try {
									return await options.queryFn(context);
								} catch (cause) {
									if (cause instanceof Error) thrown.push(cause);
									throw cause;
								}
							},
						})
						.catch(() => undefined),
				),
			);
			if (thrown.length > 0) throw thrown[0];
			if (fenced) throw new Error(STOPPED);
			// Observed from now on, so what the folder reports changed is read again.
			stopObserving = shownQueries().map((options) =>
				new QueryObserver(queryClient, options).subscribe(() => {}),
			);
			if (fenced) throw new Error(STOPPED);
			await readConnections();
			// The saved choice only: no microphone is opened or listed at launch.
			if (fenced) throw new Error(STOPPED);
			await input.load();
		},

		// ------------------------------------------------------------------
		// Lists
		// ------------------------------------------------------------------

		/** Whether `path` is a recording file, whether or not it reads as one. */
		isRecording(path: string) {
			return recordingsRead()?.paths.has(path) ?? false;
		},
		/** Saved transcripts of one recording, newest first. */
		resultsFor(id: string): TranscriptionEntry[] {
			const rows = listed(TRANSCRIPTIONS);
			return byNewest(
				(rows ? transcriptionsOf(rows) : []).filter(
					(entry) => entry.row.fields.recordingId === id,
				),
			);
		},
		/** Transformations that read, by title. */
		get transformations() {
			const rows = listed(TRANSFORMATIONS);
			return rows ? transformationsOf(rows).entries : [];
		},
		get transformationsError() {
			return readError(rowsKey(TRANSFORMATIONS));
		},
		/** Transformation files that do not read as transformations, with why. */
		get transformationRepairs() {
			const rows = listed(TRANSFORMATIONS);
			return rows ? transformationsOf(rows).repairs : [];
		},
		isTransformation(path: string) {
			const rows = listed(TRANSFORMATIONS);
			return rows ? transformationsOf(rows).paths.has(path) : false;
		},
		get transformationResults() {
			const rows = listed(TRANSFORMATION_RUNS);
			return byNewest(rows ? resultsOf(rows) : []);
		},
		/** Saved results made from one transcription, newest first. */
		outputsFor(transcriptionId: string): TransformationRunEntry[] {
			const rows = listed(TRANSFORMATION_RUNS);
			return byNewest(
				(rows ? resultsOf(rows) : []).filter(
					(entry) => entry.row.fields.transcriptionId === transcriptionId,
				),
			);
		},
		/** Saved results one transformation produced, newest first. They outlive it. */
		outputsOf(transformationId: string): TransformationRunEntry[] {
			const rows = listed(TRANSFORMATION_RUNS);
			return byNewest(
				(rows ? resultsOf(rows) : []).filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		/** Saved results on pasted text one recipe produced, newest first. */
		textOutputsOf(transformationId: string): TextRunEntry[] {
			const rows = listed(TEXT_RUNS);
			return byNewest(
				(rows ? textResultsOf(rows).entries : []).filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		get textResultsError() {
			return readError(rowsKey(TEXT_RUNS));
		},
		/** Files in `text_runs/` that do not read as results. */
		get textRepairs() {
			const rows = listed(TEXT_RUNS);
			return rows ? textResultsOf(rows).repairs : [];
		},
		/** The recording whose row names `path` as its audio, if one does. */
		recordingNaming(path: string): RecordingEntry | undefined {
			return entries().find((entry) => audioPathIn(entry.row.fields) === path);
		},
		/**
		 * Whether the audio `entry` names is in this device's folder: here,
		 * absent, or named nowhere. Read reactively. A recording this window is
		 * still capturing or writing is never reported absent.
		 */
		audioOf(entry: RecordingEntry): RecordingAudio {
			trackMutations();
			const files = listing();
			// A listing read since the recording finished says where its audio is.
			const unlisted =
				finishedOver.has(entry.stem) &&
				finishedOver.get(entry.stem) ===
					(queryClient.getQueryState(filesKey)?.dataUpdateCount ?? 0);
			if (!unlisted) finishedOver.delete(entry.stem);
			return recordingAudio(entry.row.fields, {
				listing: files,
				settling:
					unlisted ||
					capturing.has(entry.stem) ||
					queryClient.isMutating({ mutationKey: keys.recording(entry.path) }) >
						0,
			});
		},

		// ------------------------------------------------------------------
		// Recording
		// ------------------------------------------------------------------

		get recorder() {
			return recorder;
		},
		get recorderError() {
			return recorderError;
		},
		/**
		 * Start a recording: its audio file is named and its row written now,
		 * so a quit, a crash, or a closed window leaves both in the folder.
		 */
		async startRecording() {
			if (recorder.phase !== 'idle' || refused() !== undefined) return;
			recorderError = undefined;
			recorder = { phase: 'starting' };
			// A test or a pending enable holds the microphone: release it before the recording opens one.
			input.release();
			const attempt = new AbortController();
			starting = attempt;
			const at = new Date();
			const id = recordingId(at);
			const { data: capture, error: startError } =
				await services.capture.start({
					folder: recordingFolder(),
					path: recordingAudioStem(id),
					input: input.choice,
					signal: attempt.signal,
				});
			// Cancelled or closed while the microphone was opening: it is not kept.
			if (starting !== attempt) {
				if (startError === null) void capture.cancel();
				return;
			}
			starting = undefined;
			if (startError !== null) {
				recorder = { phase: 'idle' };
				recorderError = startError.message;
				input.noteRecordingError(startError);
				return;
			}
			active = { id, capture };
			capturing.add(id);
			recorder = { phase: 'recording', startedAt: capture.startedAt };
			// Facts only: when it started and where its audio is. Its length
			// follows when it stops.
			const fields: RecordingFields = {
				title: defaultTitle(at),
				recordedAt: InstantString.fromDate(at),
				capture: services.capture.source,
				audioPath: capture.audioPath,
			};
			const creating = track(
				() => folder.tables.recordings.set(id, null, { fields, body: '' }),
				rowPath(RECORDINGS, id),
			);
			startRows.set(
				id,
				creating.catch(() => undefined),
			);
			const created = await creating;
			if (created.error !== null)
				recorderError = `The recording is running, but its file could not be written, so it is not listed: ${describeError(created.error)}. Its audio is ${capture.audioPath}.`;
		},
		/** Stop: the audio file is finished and the row gets its length. */
		async stopRecording() {
			if (recorder.phase !== 'recording' || active === undefined) return;
			await finishRecording();
		},
		/** Stop and delete: the audio file and the row written at start both go. */
		async cancelRecording() {
			starting?.abort();
			starting = undefined;
			const cancelled = active;
			active = undefined;
			recorder = { phase: 'idle' };
			if (cancelled === undefined) return;
			const { id, capture } = cancelled;
			await capture.cancel();
			capturing.delete(id);
			await startRows.get(id);
			startRows.delete(id);
			const path = rowPath(RECORDINGS, id);
			const { error } = await track(
				() => folder.tables.recordings.edit(id).delete(),
				path,
			);
			if (error !== null)
				recorderError = `The recording was stopped, but its file was not deleted: ${describeError(error)}`;
			else deleted(path);
		},

		// ------------------------------------------------------------------
		// Requests and their results
		// ------------------------------------------------------------------

		transcriptionRun: runs.transcriptionRun,
		dismissRun: runs.dismissRun,
		resultState: runs.resultState,
		get recipeRuns() {
			return runs.recipeRuns;
		},
		/** Answers that arrived and whose file could not be written yet; they are written again. */
		get unwrittenAnswers() {
			return runs.unwritten;
		},
		transcribe: runs.transcribe,
		transform: runs.transform,
		transformText: runs.transformText,
		runAgain: runs.runAgain,

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		/**
		 * A new recipe file: a title and instructions. It names no model of its
		 * own (`null`), so it runs with the text connection.
		 */
		async createTransformation(input: { title: string; prompt: string }) {
			const id = recordingId(new Date());
			const path = rowPath(TRANSFORMATIONS, id);
			const why = await createTransformation(id, input);
			if (why !== undefined || fenced) return why;
			// Listed before it opens, so the page never says it is gone. A read
			// for this view, after the action: closing never waits for it, and
			// it joins the read the save's change started.
			await local.refresh([path]);
			open(path);
			return undefined;
		},
		deleteTransformationResult: action(
			'delete-result',
			deleteResult(TRANSFORMATION_RUNS),
		),
		deleteTextResult: action('delete-text-result', deleteResult(TEXT_RUNS)),

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to the folder.
		 */
		saveConnection,
		/** Read the connections again, as after a failed read. */
		readConnections,

		/**
		 * Rename a file within its directory: its exact bytes are saved at the
		 * new name, then the old name is deleted as it was copied. Recording
		 * and transformation files keep their names, and so does audio a
		 * recording names. Typing held for the file saves first; edits of it
		 * wait meanwhile. A file changed during the rename is kept at both
		 * names, and the person is told.
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
			if (entries().some((entry) => audioPathIn(entry.row.fields) === path))
				return RECORDING_AUDIO_NAME;
			if (
				rowIdOf(TRANSCRIPTIONS, path) !== undefined &&
				rowIdOf(TRANSCRIPTIONS, to) === undefined &&
				!showsText(path)
			)
				return TRANSCRIPT_NAME;
			if (taken(to)) return TAKEN;
			if (busyPaths.has(path) || busyPaths.has(to))
				return 'This file is being changed. Try again when it is done.';
			busyPaths.add(path);
			busyPaths.add(to);
			try {
				return await hold(
					local.run(async () => {
						if (await settlePath(path)) return UNSAVED;
						const { data: bytes, error: readError } = await readBytes(
							folder,
							path,
						);
						if (readError !== null) return readError;
						const { error: copyError } = await folder.files.write(
							to,
							null,
							bytes,
						);
						if (copyError !== null) return describeError(copyError);
						const { data: removed, error: removeError } =
							await folder.files.delete(path, bytes);
						if (removeError !== null)
							return `${to} was saved, but ${path} was not deleted, so both are in the folder: ${describeError(removeError)}`;
						if (!removed.deleted)
							return `${to} was saved, but ${path} changed meanwhile, so both are kept. Check them.`;
						moved(path, to);
						return undefined;
					}),
				);
			} finally {
				busyPaths.delete(path);
				busyPaths.delete(to);
			}
		},
		/** A new empty text file, shown; it is never made where a file is listed. */
		createFile: action(
			'create-file',
			async (directory: string, name: string) => {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				if (taken(path)) return `"${name}" already exists here.`;
				const { error } = await folder.files.write(path, null, '');
				if (error !== null) return describeError(error);
				open(path);
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Typing held for it saves first.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion(deletionContext(), path);
		},
		/**
		 * Delete what was confirmed, as it is stored: a file that changed after
		 * the person was asked is kept, and the answer says so.
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
			const paths =
				deletion.kind === 'recording'
					? [deletion.path, ...deletion.results]
					: [deletion.path];
			for (const path of paths) busyPaths.add(path);
			try {
				return await hold(
					local.run(() =>
						runDeletion(
							{
								...deletionContext(),
								deleting,
								dropFailed: runs.dropFailed,
								deleted,
							},
							deletion,
						).catch((cause: unknown) => describe(cause)),
					),
				);
			} finally {
				for (const path of paths) busyPaths.delete(path);
			}
		},
		/**
		 * Stop new work, finish a recording that is running, wait for accepted
		 * workflow work, then stop observers. Folder settles accepted file edits
		 * and closes storage after this finishes. An
		 * answer whose file could not be written ends with the page, and its
		 * row stays unfinished.
		 */
		stop(): Promise<void> {
			stopping ??= (async () => {
				fenced = true;
				runs.stop();
				// The microphone first: nothing still being written may keep it open.
				input.close();
				starting?.abort();
				starting = undefined;
				// Kept, never deleted: a recording is in the folder from its start.
				await finishRecording();
				await Promise.allSettled([...pending]);
				await input.saved();
				for (const stop of stopObserving) stop();
				stopListening();
				stopTelling();
				recordingsListed.clear();
				noticeListeners.clear();
			})();
			return stopping;
		},
	};
}
