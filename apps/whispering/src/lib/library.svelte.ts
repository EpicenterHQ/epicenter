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
 * Typing is never lost to a reread. Fields, body and whole text use one
 * FileEdit interface, selected through a typed table or file path. Each
 * failed save is reported. Folder saves a second after the last
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
import type { Pending } from '@epicenter/folder/edits';
import { ancestors, dirname, joinPath } from '@epicenter/folder/file-browser';
import type { RecordingFolder } from '@epicenter/recorder';
import {
	createFileEdit,
	type FileEdit,
} from '@epicenter/svelte/edits';
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
import { describeError, listingOf, nameProblem } from './files.js';
import type { WhisperingContext } from './folder.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import type { WhisperingServices } from './platform/types.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { type RecordingAudio, recordingAudio } from './recording-audio.js';
import { createRuns } from './runs.svelte.js';

export const STOPPED = 'Whispering stopped before it finished starting.';

export type Library = ReturnType<typeof createLibrary>;

/** A listing's query options, as the first read runs them. */
type QueryOptions = {
	queryKey: readonly unknown[];
	queryFn: (context: QueryFunctionContext) => Promise<unknown>;
};

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

	const noticeListeners = new Set<(notice: WriteFailure) => void>();
	function notify(notice: WriteFailure) {
		for (const listener of noticeListeners) listener(notice);
	}

	/** Set by `stop`: nothing new starts from then on. Work accepted before finishes. */
	let fenced = $state(false);
	let stopping: Promise<void> | undefined;
	let captureNotice = $state<string | undefined>();
	/** Why nothing new starts now, if it does not. */
	const refused = () => (fenced ? CLOSING : undefined);
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

	// --- editing ---------------------------------------------------------------

	/** One tracked file edit; table access also binds its read schema. */
	function editAt(path: string): FileEdit;
	function editAt<T extends RowTable>(
		table: T,
		path: string,
	): FileEdit<WhisperingTables[T]>;
	function editAt(tableOrPath: string, path?: string): FileEdit {
		const target = path ?? tableOrPath;
		const table =
			path === undefined ? rowTableOf(target) : (tableOrPath as RowTable);
		if (table === undefined) return createFileEdit(folder.files.edit(target));
		const id = rowIdOf(table, target);
		if (id === undefined)
			throw new Error(`${target} is not a file in the ${table} table.`);
		return createFileEdit<WhisperingTables[RowTable]>(folder.tables[table].edit(id));
	}
	// Each save of a file's text that fails is told once, with the text to
	// copy, a save and a discard: a failure the folder reports that was not
	// reported before. Typing over failed text clears it and tells nothing.
	let told = new Set<Pending>();
	const stopTelling = folder.onStatusChange(({ failures }) => {
		const failed = new Set<Pending>();
		for (const pending of failures) {
			if (pending.kind !== 'text' || pending.error === undefined) continue;
			failed.add(pending);
			if (told.has(pending)) continue;
			const { path } = pending;
			notify({
				path,
				error: pending.error,
				unsaved: pending.text,
				save: () => {
					if (fenced) return false;
					void folder.files.edit(path).save();
					return true;
				},
				discard: () => {
					const discarded = folder.files.edit(path).discard();
					return discarded?.kind === 'text' ? discarded.text : undefined;
				},
			});
		}
		told = failed;
	});

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
		const stem = rowIdOf(table, path) as string;
		const row =
			editAt(table, path).markdown ??
			listed(table)?.find((item) => item.id === stem);
		return row !== undefined && row.issues !== null;
	}

	/** Send the typing held for `path`, row or text; answers whether some still did not save. */
	async function settlePath(path: string): Promise<boolean> {
		const fileEdit = folder.files.edit(path);
		await fileEdit.save();
		return fileEdit.getPending() !== undefined;
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
		| {
				readonly id: string;
				readonly capture: ActiveCapture;
				/** Its initial row save, awaited before Stop or Cancel changes that row. */
				readonly rowSave: ReturnType<typeof folder.tables.recordings.set>;
		  }
		| undefined;
	/** The recording being captured, by stem. No request starts for it until it stops. */
	const capturing = new SvelteSet<string>();
	/**
	 * A recording this window just finished, by stem, with the file listing
	 * read when its capture ended. Until the folder is listed again, that
	 * listing may predate its audio, so the audio is not reported absent.
	 */
	const finishedOver = new Map<string, { count: number; path: string }>();
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
		if (active === undefined || recorder.phase !== 'recording') return;
		const { id, capture, rowSave } = active;
		recorder = { phase: 'stopping' };
		const path = rowPath(RECORDINGS, id);
		const selectionBefore = selectedPath;
		// In a browser, and for fixture audio, the audio file is written now; on
		// the desktop it was written as it was captured, and stop finishes it.
		// Started here, not when the mutation runs, so the microphone is let go
		// at once.
		const stopping = capture
			.stop()
			.catch((cause) => CaptureError.Failed({ cause }));
		const { data: stopped, error: stopError } = await track(() => stopping);
		if (stopError === null)
			finishedOver.set(id, {
				count: queryClient.getQueryState(filesKey)?.dataUpdateCount ?? 0,
				path: capture.audioPath,
			});
		active = undefined;
		capturing.delete(id);
		recorder = { phase: 'idle' };
		if (stopError !== null) {
			recorderError = stopError.message;
			return;
		}
		const saveWarning = await track(async () => {
			const { error: rowError } = await rowSave;
			if (rowError !== null)
				return `The audio is saved, but its recording file could not be written: ${describeError(rowError)}. Its audio is ${capture.audioPath}.`;
			const { data: stored, error } = await folder.tables.recordings.get(id);
			if (error !== null)
				return `The recording is saved, but its length could not be written: ${describeError(error)}`;
			// A row deleted meanwhile stays deleted.
			if (stored === undefined) return undefined;
			const { error: saveError } = await folder.tables.recordings.set(id, stored, {
				fields: { durationMs: stopped.durationMs },
			});
			return saveError === null
				? undefined
				: `The recording is saved, but its length could not be written: ${describeError(saveError)}`;
		}, path);
		if (saveWarning !== undefined) recorderError = saveWarning;
		if (selectedPath === selectionBefore) open(path);
	}

	function audioOf(entry: RecordingEntry): RecordingAudio {
		trackMutations();
		const files = listing();
		// A listing read since the recording finished says where its audio is.
		const unlisted =
			finishedOver.has(entry.stem) &&
			finishedOver.get(entry.stem)?.count ===
				(queryClient.getQueryState(filesKey)?.dataUpdateCount ?? 0);
		if (!unlisted) finishedOver.delete(entry.stem);
		return recordingAudio(entry.stem, {
			capturePath:
				active?.id === entry.stem
					? active.capture.audioPath
					: finishedOver.get(entry.stem)?.path,
			listing: files,
			settling:
				unlisted ||
				capturing.has(entry.stem) ||
				queryClient.isMutating({ mutationKey: keys.recording(entry.path) }) > 0,
		});
	}

	function recordingNaming(path: string): RecordingEntry | undefined {
		return entries().find((entry) => {
			const audio = audioOf(entry);
			return audio.kind === 'here' && audio.path === path;
		});
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		settle: settlePath,
		busy: (id) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
		audioOf: (path) => {
			const entry = recordingNaming(path);
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
				!local.getStatus().unsaved.includes(path)
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
				!local.getStatus().unsaved.includes(path)
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
		// Edits
		// ------------------------------------------------------------------

		/** The current file edit; a table argument binds typed fields and diagnostics. */
		edit: editAt,
		/** Whether `path` shows as its exact text rather than its fields. */
		showsText(path: string) {
			return showsText(path);
		},
		/** Hear each save of a file's text that failed, which the person is told. */
		onWriteFailure(listener: (notice: WriteFailure) => void): () => void {
			noticeListeners.add(listener);
			return () => noticeListeners.delete(listener);
		},
		/** Whether a save of `path` runs or waits, or typing there waits to be sent; read reactively. */
		isSaving(path: string) {
			const pending = editAt(path).pending;
			return pending !== undefined && (pending.saving || pending.error === undefined);
		},
		/** Whether typing at `path` did not save, with no save running; read reactively. */
		isUnsaved(path: string) {
			const pending = editAt(path).pending;
			return pending?.error !== undefined && !pending.saving;
		},

		/**
		 * Let go of what is typed into `path` and did not save, leaving the file
		 * as it is. Answers what was let go, for the person to copy, or
		 * undefined when nothing was held or a save of it is running.
		 */
		discard(path: string): string | undefined {
			const discarded = folder.files.edit(path).discard();
			if (discarded === undefined) return undefined;
			// A body alone stays plain text for copying back into its control.
			if (
				discarded.kind === 'document' &&
				Object.keys(discarded.fields).length === 0
			)
				return discarded.body;
			return unsavedText(discarded);
		},
		/** Whether a save runs, or typing waits to be sent; read reactively. */
		get saving() {
			const { saving, unsaved, failures } = local.getStatus();
			// Held paths that have not failed wait to be sent or are saving.
			return saving || unsaved.length > failures.length;
		},
		/** Whether typing did not save, here or in a file's text; read reactively. */
		get unsaved() {
			return local.getStatus().failures.length > 0;
		},
		/** Why the last save failed in storage, until a save lands; read reactively. */
		get storageFailure(): string | undefined {
			const failure = local.getStatus().storageFailure;
			return failure === null ? undefined : describeError(failure);
		},
		/** Show the same path-owned edit as whole text; no save or reread is required. */
		editSource(path: string): string | undefined {
			const why = refused();
			if (why !== undefined) return why;
			asText.add(path);
			return undefined;
		},
		/** Show structured fields when the current edit fits the row's schema. */
		useForm(path: string): string | undefined {
			const why = refused();
			if (why !== undefined) return why;
			const fileEdit = editAt(path);
			if (fileEdit.markdown?.issues !== null)
				return STILL_TEXT;
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
			return (recorder.phase === 'recording' || recorder.phase === 'stopping') &&
				active?.capture.audioPath === path
				? recorder.phase
				: undefined;
		},

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
			const { data: capture, error: startError } = await services.capture.start(
				{
					folder: recordingFolder(),
					path: recordingAudioStem(id),
					input: input.choice,
					signal: attempt.signal,
				},
			);
			// Cancelled or closed while the microphone was opening: it is not kept.
			if (starting !== attempt) {
				if (startError === null) {
					const { error } = await capture
						.cancel()
						.catch((cause) => CaptureError.Failed({ cause }));
					if (error !== null && !fenced)
						recorderError = `The late recording's cancellation could not be confirmed: ${error.message}`;
				}
				return;
			}
			starting = undefined;
			if (startError !== null) {
				recorder = { phase: 'idle' };
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
			const creating = track(
				() => folder.tables.recordings.set(id, null, { fields, body: '' }),
				rowPath(RECORDINGS, id),
			);
			// Stop and Cancel await this capture's own initial row save.
			active = { id, capture, rowSave: creating };
			capturing.add(id);
			recorder = { phase: 'recording', startedAt: capture.startedAt };
			capture.onEnded((reason) => {
				if (active?.capture !== capture) return;
				recorderError = {
					deviceDisconnected:
						'The microphone was disconnected. Recording stopped.',
					permissionRevoked:
						'Microphone permission was revoked. Recording stopped.',
					streamFailed: 'The microphone stream failed. Recording stopped.',
					storageFailed: 'Audio storage failed. Recording stopped.',
				}[reason];
				// Stop owns finalization; it keeps the captured audio and this row.
				void hold(finishRecording());
			});
			const created = await creating;
			if (
				created.error !== null &&
				active?.capture === capture &&
				recorderError === undefined
			)
				recorderError = `The recording is running, but its file could not be written, so it is not listed: ${describeError(created.error)}. Its audio is ${capture.audioPath}.`;
		},
		/** Stop: the audio file is finished and the row gets its length. */
		async stopRecording() {
			if (recorder.phase !== 'recording' || active === undefined) return;
			await finishRecording();
		},
		/** Stop and delete: the audio file and the row written at start both go. */
		async cancelRecording() {
			if (recorder.phase === 'stopping') return;
			starting?.abort();
			starting = undefined;
			const cancelled = active;
			active = undefined;
			if (cancelled === undefined) {
				// Another Stop or Cancel may still own the microphone.
				if (recorder.phase === 'starting') recorder = { phase: 'idle' };
				return;
			}
			recorder = { phase: 'stopping' };
			await hold(
				(async () => {
					const { id, capture, rowSave } = cancelled;
					const { error: cancelError } = await capture
						.cancel()
						.catch((cause) => CaptureError.Failed({ cause }));
					if (cancelError !== null) {
						// The native reply may be lost after cancellation. Keep the row
						// and handle so an explicit Stop or Cancel can resolve it.
						active = cancelled;
						recorder = { phase: 'recording', startedAt: capture.startedAt };
						recorderError = `The recording's cancellation could not be confirmed. Its row was kept: ${cancelError.message}`;
						// Closing preserves the recording by finishing it, as ordinary
						// teardown does, rather than leaving its microphone held.
						if (fenced) await finishRecording();
						return;
					}
					capturing.delete(id);
					recorder = { phase: 'idle' };
					await rowSave;
					const path = rowPath(RECORDINGS, id);
					const { error } = await track(
						() => folder.tables.recordings.edit(id).delete(),
						path,
					);
					if (error !== null)
						recorderError = `The recording was stopped, but its file was not deleted: ${describeError(error)}`;
					else deleted(path);
				})(),
			);
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
			if (recordingNaming(path) !== undefined) return RECORDING_AUDIO_NAME;
			if (
				rowIdOf(TRANSCRIPTIONS, path) !== undefined &&
				rowIdOf(TRANSCRIPTIONS, to) === undefined &&
				!showsText(path)
			)
				return TRANSCRIPT_NAME;
			if (taken(to)) return TAKEN;
			const outcome = await folder.files.exclusive([path, to], async (files) => {
				const source = files.get(path)!;
				const destination = files.get(to)!;
				const { data: found, error: readError } = await source.read();
				if (readError !== null) return describeError(readError);
				if (found === undefined) return `No file exists at '${path}'.`;
				const bytes = new Uint8Array(await found.content.arrayBuffer());
				const { error: copyError } = await destination.write(null, bytes);
				if (copyError !== null) return describeError(copyError);
				const { data: removed, error: removeError } = await source.delete(bytes);
				if (removeError !== null)
					return `${to} was saved, but ${path} was not deleted, so both are in the folder: ${describeError(removeError)}`;
				if (!removed.deleted)
					return `${to} was saved, but ${path} changed meanwhile, so both are kept. Check them.`;
				if (!fenced) moved(path, to);
				return undefined;
			});
			return outcome.error === null ? outcome.data : describeError(outcome.error);
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
			if (recording !== undefined) deleting.add(recording);
			try {
				const outcome = await folder.files.exclusive(paths, async (files) => {
					const why = refused();
					if (why !== undefined) return why;
					return runDeletion(
						{
							...deletionContext(),
							dropFailed: runs.dropFailed,
							deleted: (path) => { if (!fenced) deleted(path); },
							refused,
						},
						deletion,
						files,
					).catch((cause: unknown) => describe(cause));
				});
				return outcome.error === null ? outcome.data : describeError(outcome.error);
			} finally {
				if (recording !== undefined) deleting.delete(recording);
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
				folder.stopEditing();
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
