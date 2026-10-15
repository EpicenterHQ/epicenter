/**
 * The Whispering product state over one opened workspace, kept in a TanStack
 * Query cache (ADR-0528, ADR-0548).
 *
 * Reads are the folder's queries (`folderOptions`): each table's rows, the
 * listing the file browser shows, `kv.json`, Git status, and the text of each
 * file opened as text. The library observes the listings and Git status for
 * as long as it is open, so every page shows them. They are read when the
 * page opens and after the app's own actions and terminal commands; changes
 * made anywhere else arrive on `folder.onFilesChanged`, which makes exactly
 * the queries they name stale. Rows that read are listed to edit; the rest
 * are named, with why, for repair as text.
 *
 * An edit holds its own starting version, outside the cache: a draft per row
 * file (`createDraftState`), and per file edited as its exact text. A read
 * never touches a draft. A row's draft saves with `table.save`, one save at a
 * time, which merges with whatever changed since the edit started. A file's
 * text is a text draft (`createTextDraftState`), saved over the version it
 * started from and merged by line the same way (ADR-0551). A save that
 * replaced another writer's change says so, with a way to put theirs back.
 * A text save that fails is reported with the text that was not written. A
 * row deleted elsewhere stays deleted: its save fails, and nothing creates
 * it again.
 *
 * Every other action is a mutation: a recording's row and its length,
 * writing a transcript or a result (scoped by the recording's file, so they
 * write in order), create, rename, delete, Save version, settings, and
 * terminal commands. Closing stops new work, then waits for the edits and
 * until nothing is mutating. Saves never commit (ADR-0529); a version is
 * recorded only by Save version.
 *
 * A recording is in the folder from the moment it starts (ADR-0543): its row
 * is written then, naming its audio, and on the desktop the audio is written
 * as it is captured. Whether it is still running is this window's live
 * capture, never a field. A transcription or recipe run is in the folder
 * from its start too (ADR-0542): its result row is written before the request
 * goes out, and its body when the answer arrives (`runs.svelte.ts`).
 */

import { InstantString } from '@epicenter/definition';
import type {
	CommitOutcome,
	FileCapture,
	FileError,
	FileListing,
	FileSaveError,
	FileTable,
	KvReading,
	MoveError,
	Replaced,
	Row,
	RowReadError,
	SavedFile,
	SavedRow,
	StoredRow,
	TableError,
	TableListing,
	TableSaveError,
} from '@epicenter/folder';
import {
	formatRow,
	parseRow,
	restoreTheirs,
	rowPath,
	rowStemOf,
} from '@epicenter/folder';
import {
	ancestorsOf,
	dirname,
	joinPath,
	type OpenedFile,
} from '@epicenter/folder/file-browser';
import {
	folderOptions,
	type SaveRowVariables,
	type TableOptions,
} from '@epicenter/folder/query';
import {
	createDraftState,
	createTextDraftState,
	type DraftState,
	type TextDraftState,
} from '@epicenter/folder/svelte';
import { type RecordingFolder, recoverRecordings } from '@epicenter/recorder';
import {
	hashKey,
	type MutationObserverOptions,
	type QueryClient,
	type QueryFunctionContext,
	QueryObserver,
} from '@tanstack/query-core';
import { customAlphabet } from 'nanoid';
import { createSubscriber, SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	createQueryFactories,
	defineKeys,
	resultQueryOptions,
} from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ActiveCapture } from './capture.js';
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
	recordingAudioStem,
	TEXT_RUNS,
	type TextRunFields,
	TRANSCRIPTIONS,
	TRANSFORMATION_RUNS,
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
import { describeError, nameProblem, readTextFile } from './files.js';
import { createMicrophoneInput } from './microphone-input.svelte.js';
import {
	type RecipeRow,
	type ResolvedRecipe,
	resolveRecipe,
} from './recipe.js';
import { createRuns } from './runs.svelte.js';
import { createTerminalSession } from './terminal.svelte.js';
import type {
	TerminalResult,
	Workspace,
	WorkspaceTerminal,
} from './workspace/index.js';
import {
	type RecordingWriteHook,
	WHISPERING_FOLDER_ID,
} from './workspace/types.js';

export type Library = ReturnType<typeof createLibrary>;

/** A listing's query options, as the first read runs them. */
type QueryOptions = {
	queryKey: readonly unknown[];
	queryFn: (context: QueryFunctionContext) => Promise<unknown>;
};

/** The fields of each table, by its name. */
type Tables = {
	recordings: RecordingFields;
	transcriptions: TranscriptionFields;
	transformations: TransformationFields;
	transformation_runs: TransformationRunFields;
	text_runs: TextRunFields;
};
export type TableName = keyof Tables;
/** The tables whose rows this window edits. */
export type RowTable =
	| typeof RECORDINGS
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATIONS;

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

/** What the person is told about an edit's write. */
export type WriteNotice =
	/**
	 * The write failed. A row's edit is kept and is saved again with the
	 * next change, or before anything that reads it. `lost` is the text that
	 * was dropped instead: a row whose file is gone, or text whose save
	 * failed.
	 */
	| {
			readonly kind: 'failed';
			readonly path: string;
			readonly error: TableError | FileError | FileSaveError;
			readonly lost: string | undefined;
	  }
	/**
	 * The save landed, and replaced what another writer changed in the same
	 * places; `restore` is the one more save that puts theirs back.
	 */
	| {
			readonly kind: 'replaced';
			readonly path: string;
			readonly replaced: readonly Replaced[];
			readonly restore: () => void;
	  };

export type RecorderState =
	| { readonly phase: 'idle' }
	| { readonly phase: 'starting' }
	| { readonly phase: 'recording'; readonly startedAt: number }
	| { readonly phase: 'stopping' };

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

/**
 * Cache identity for the app's own actions. What the folder holds is cached
 * under the folder's keys (`folderOptions`).
 */
export const whisperingKeys = defineKeys({
	/** Every action the app runs. */
	all: ['whispering'],
	move: (path: string) => ['whispering', 'move', path] as const,
	remove: (path: string) => ['whispering', 'remove', path] as const,
	/** A recording's lifecycle: its row and length, and saving its transcripts and results. */
	recording: (path: string) => ['whispering', 'recording', path] as const,
	action: (name: string) => ['whispering', 'action', name] as const,
});

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

/** The row table a path is a row of, if it is one this window edits. */
export function rowTableOf(path: string): RowTable | undefined {
	for (const table of [RECORDINGS, TRANSCRIPTIONS, TRANSFORMATIONS] as const)
		if (rowStemOf(table, path) !== undefined) return table;
	return undefined;
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
		paths: new Set(listed.map(({ stem }) => rowPath(table, stem))),
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

/**
 * Resolves once nothing is mutating. It watches the mutation cache, so a
 * mutation that starts meanwhile is waited for too.
 */
function whenIdle(queryClient: QueryClient): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating() > 0) return;
			unsubscribe();
			resolve();
		}
		check();
	});
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

export function createLibrary(workspace: Workspace, queryClient: QueryClient) {
	const { folder } = workspace;
	const keys = whisperingKeys;
	const folder$ = folderOptions(folder);
	const { defineMutation } = createQueryFactories(queryClient);
	const tableOf = <T extends TableName>(name: T) =>
		folder.tables[name] as unknown as FileTable<Tables[T]>;
	const optionsOf = <T extends TableName>(name: T) =>
		folder$.tables[name] as TableOptions<Tables[T]>;

	let closing = $state(false);

	/** Why nothing new starts now, if it does not. Work accepted before stays accepted. */
	function refused(): string | undefined {
		return closing ? CLOSING : undefined;
	}

	// Every read and write is local: nothing waits for a network, and a read
	// or write that failed is shown rather than retried.
	queryClient.setQueryDefaults(folder$.key, {
		networkMode: 'always',
		retry: false,
		retryOnMount: false,
		// Nothing goes stale on its own: what changed is read when the folder
		// reports it, or after the app's own action.
		staleTime: Number.POSITIVE_INFINITY,
	});
	for (const key of [folder$.key, keys.all])
		queryClient.setMutationDefaults(key, {
			networkMode: 'always',
			retry: false,
		});

	// The one channel of outside change (ADR-0548): each report makes exactly
	// the queries it names stale, and the ones shown are read again.
	const stopChanges = folder.onFilesChanged((change) =>
		queryClient.invalidateQueries(folder$.pathFilter(change)),
	);

	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe(update),
	);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));

	// --- reads -----------------------------------------------------------------

	const listingOf = <T extends TableName>(table: T) =>
		optionsOf(table).list.queryOptions();
	/** The key a file's text is cached under: beside the folder's read of that file, so a change to it reaches both. */
	const textKey = (path: string) =>
		[...folder$.files.read.queryKey(path), 'opened'] as const;
	/**
	 * One file's complete text, or its type and size when it is not editable
	 * text. The same options object for each path, so a view that asks again
	 * does not change its query's options.
	 */
	const textQueries = new Map<string, ReturnType<typeof textQueryOf>>();
	const textQueryOf = (path: string) =>
		resultQueryOptions({
			queryKey: textKey(path),
			queryFn: () => readTextFile(folder.files, path),
		});
	function textQuery(path: string) {
		let options = textQueries.get(path);
		if (options === undefined) {
			options = textQueryOf(path);
			textQueries.set(path, options);
		}
		return options;
	}
	/** The listings every page shows: the tables, the files, and `kv.json`. */
	const listingQueries = () => [
		listingOf(RECORDINGS),
		listingOf(TRANSCRIPTIONS),
		listingOf(TRANSFORMATIONS),
		listingOf(TRANSFORMATION_RUNS),
		listingOf(TEXT_RUNS),
		folder$.files.list.queryOptions(),
		folder$.kv.get.queryOptions(),
	];
	/**
	 * What the library observes while it is open: the listings, and Git
	 * status, whose read updates the folder's history snapshot the header
	 * shows. Observed, they are read again whenever they go stale.
	 */
	const shownQueries = () => [
		...listingQueries(),
		folder$.history.status.queryOptions(),
	];
	const listingKeys = listingQueries().map((options) => options.queryKey);
	/** Stops observing what `start` began observing. */
	let stopObserving: (() => void)[] = [];

	/** A listing as the cache holds it, read reactively. */
	function listed<T extends TableName>(table: T) {
		trackQueries();
		return queryClient.getQueryData<TableListing<Tables[T]>>(
			optionsOf(table).list.queryKey(),
		);
	}
	/** Why the last read of a query failed, read reactively. */
	function readError(queryKey: readonly unknown[]): string | undefined {
		trackQueries();
		return queryClient.getQueryState(queryKey)?.error?.message;
	}
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(textKey(path));

	const recordingsOf = perListing((listing: TableListing<RecordingFields>) => {
		const read = split(RECORDINGS, listing);
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
		(listing: TableListing<TransformationFields>) => {
			const read = split(TRANSFORMATIONS, listing);
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
		(listing: TableListing<TranscriptionFields>) =>
			split(TRANSCRIPTIONS, listing).entries,
	);
	const resultsOf = perListing(
		(listing: TableListing<TransformationRunFields>) =>
			split(TRANSFORMATION_RUNS, listing).entries,
	);
	const textResultsOf = perListing((listing: TableListing<TextRunFields>) =>
		split(TEXT_RUNS, listing),
	);

	const recordingsRead = () => {
		const listing = listed(RECORDINGS);
		return listing && recordingsOf(listing);
	};
	const entries = () => recordingsRead()?.entries ?? [];

	/** The row the cache holds for `stem`, if it reads. */
	function rowOf<T extends RowTable>(
		table: T,
		stem: string,
	): StoredRow<Tables[T]> | undefined {
		const result = queryClient
			.getQueryData<TableListing<Tables[T]>>(optionsOf(table).list.queryKey())
			?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** The text a person loses with a row that could not be written. */
	function rowText<T extends RowTable>(table: T, row: Row<Tables[T]>) {
		const formatted = formatRow(
			whisperingDefinition.tables[table] as never,
			row as never,
		) as Result<string, unknown>;
		return formatted.data ?? row.body;
	}

	/** Read again what an action may have changed: every folder query a view shows, Git status with them. */
	async function invalidate() {
		if (closing) return;
		await queryClient.invalidateQueries({ queryKey: folder$.key });
	}

	/** Git status after one of the app's own saves, which the folder does not report to this page. */
	const statusMoved = () =>
		void queryClient.invalidateQueries({
			queryKey: folder$.history.status.queryKey(),
		});

	/** Whether a rename or delete of `path` is running or waiting, which pauses its edits. */
	const moving = (path: string) =>
		queryClient.isMutating({ mutationKey: keys.move(path), exact: true }) +
			queryClient.isMutating({ mutationKey: keys.remove(path), exact: true }) >
		0;

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
		const stem = rowStemOf(table, path) as string;
		const result = listed(table)?.find((entry) => entry.stem === stem)?.result;
		return result !== undefined && result.error !== null;
	}

	/**
	 * The capture a rename or delete of `path` acts on, read when it runs: the
	 * newest hash the cache confirmed for what the app edits, if it holds one.
	 */
	function heldCapture(path: string): FileCapture | undefined {
		const table = rowTableOf(path);
		if (table !== undefined && !asText.has(path)) {
			const stem = rowStemOf(table, path);
			const result = queryClient
				.getQueryData<TableListing<unknown>>(optionsOf(table).list.queryKey())
				?.find((entry) => entry.stem === stem)?.result;
			if (result?.error === null)
				return { path: result.data.path, sha256: result.data.sha256 };
			if (result?.error.name === 'InvalidRow')
				return { path: result.error.path, sha256: result.error.sha256 };
		}
		const opened = textData(path);
		return opened?.kind === 'text'
			? { path: opened.file.path, sha256: opened.file.sha256 }
			: undefined;
	}

	// --- edits -----------------------------------------------------------------

	const noticeListeners = new Set<(notice: WriteNotice) => void>();
	function notify(notice: WriteNotice) {
		for (const listener of noticeListeners) listener(notice);
	}

	/** Run a mutation from its options now, as a view's `mutateAsync` does: it rejects with the mutation's error. */
	function execute<TData, TError, TVariables>(
		options: MutationObserverOptions<TData, TError, TVariables>,
		variables: TVariables,
	): Promise<TData> {
		return queryClient
			.getMutationCache()
			.build(queryClient, options)
			.execute(variables);
	}

	type Fields = Record<string, unknown>;
	/**
	 * Each row file's edit, by path: the version it started from and the row
	 * as typed. Held here rather than by a view, so an edit outlives the view
	 * it was made in, as the session does.
	 */
	const rowDrafts = new SvelteMap<string, DraftState<Fields>>();

	function rowDraft(table: RowTable, path: string): DraftState<Fields> {
		const held = rowDrafts.get(path);
		if (held !== undefined) return held;
		const save = optionsOf(
			table,
		).save.mutationOptions() as unknown as MutationObserverOptions<
			SavedRow<Fields>,
			TableSaveError,
			SaveRowVariables<Fields>
		>;
		const draft = createDraftState<Fields>({
			save: (sent) =>
				execute(save, sent).catch((error: TableSaveError) => {
					rowSaveFailed(table, path, error);
					throw error;
				}),
			onSaved: (saved) => savedRow(save, path, saved),
		});
		rowDrafts.set(path, draft);
		return draft;
	}

	/** A row's save landed: Git status moved, and what it replaced is named. */
	function savedRow(
		save: MutationObserverOptions<
			SavedRow<Fields>,
			TableSaveError,
			SaveRowVariables<Fields>
		>,
		path: string,
		saved: SavedRow<Fields>,
	) {
		statusMoved();
		if (saved.replaced.length === 0) return;
		notify({
			kind: 'replaced',
			path,
			replaced: saved.replaced,
			restore: () =>
				void execute(save, restoreTheirs(saved))
					.then((restored) => savedRow(save, path, restored))
					.catch(() => {}),
		});
	}

	/**
	 * A row's save failed. Its edit is kept for the next save, unless the
	 * file is gone: a save never recreates a row, so that edit is dropped.
	 */
	function rowSaveFailed(table: RowTable, path: string, error: TableSaveError) {
		if (error.name !== 'NotFound') {
			notify({ kind: 'failed', path, error, lost: undefined });
			return;
		}
		const draft = rowDrafts.get(path);
		const lost =
			draft?.row === undefined
				? undefined
				: rowText(table, draft.row as Row<never>);
		draft?.discard();
		notify({ kind: 'failed', path, error, lost });
		// The listing reads the file gone.
		void queryClient.invalidateQueries(folder$.pathFilter([path]));
	}

	/** Each file's text edit, by path: the version it started from and the text typed. */
	const textEdits = new SvelteMap<string, TextDraftState>();
	const writeFile = folder$.files.write.mutationOptions();

	/**
	 * A text save landed. The page's own write is not reported to it: what
	 * reads this file, a row of it included, is read again, and what it
	 * replaced is named.
	 */
	function savedText(path: string, saved: SavedFile) {
		queryClient.setQueryData<OpenedFile>(textKey(path), {
			kind: 'text',
			file: {
				path,
				sha256: saved.stored.sha256,
				text: new TextDecoder().decode(saved.stored.bytes),
			},
		});
		void queryClient.invalidateQueries(folder$.pathFilter([path]));
		if (saved.replaced.length === 0) return;
		notify({
			kind: 'replaced',
			path,
			replaced: saved.replaced,
			restore: () => {
				const { base, content } = restoreTheirs(saved, folder.definition);
				void execute(writeFile, { path, content, base })
					.then((restored) => savedText(path, restored))
					.catch(() => {});
			},
		});
	}

	/** The text edit of `path`, made at its first change. */
	function textEdit(path: string): TextDraftState {
		const held = textEdits.get(path);
		if (held !== undefined) return held;
		const draft = createTextDraftState({
			save: ({ base, text }) =>
				execute(writeFile, { path, content: text, base }).catch(
					(error: FileSaveError) => {
						// What was typed is reported with the failure and dropped, so
						// the view shows the file as it is.
						const lost = draft.text ?? text;
						draft.discard();
						textEdits.delete(path);
						notify({ kind: 'failed', path, error, lost });
						void queryClient.invalidateQueries(folder$.pathFilter([path]));
						throw error;
					},
				),
			onSaved: (saved) => savedText(path, saved),
		});
		textEdits.set(path, draft);
		return draft;
	}

	/** Save the text typed into `path` until nothing is left; then the edit is done. */
	async function saveText(path: string): Promise<void> {
		const draft = textEdits.get(path);
		if (draft === undefined) return;
		await draft.save();
		if (draft.text === undefined && textEdits.get(path) === draft)
			textEdits.delete(path);
	}

	/** Resolves once every edit has been written, or its write failed. */
	async function writesSettled() {
		await Promise.all([
			...[...rowDrafts.values()].map((draft) => draft.save()),
			...[...textEdits.keys()].map(saveText),
		]);
	}

	/** After a rename: the caches and the selection follow the file. */
	function moved(from: string, to: string) {
		const stem = rowStemOf(TRANSCRIPTIONS, from);
		const nextStem = rowStemOf(TRANSCRIPTIONS, to);
		if (stem !== undefined)
			queryClient.setQueryData<TableListing<TranscriptionFields>>(
				optionsOf(TRANSCRIPTIONS).list.queryKey(),
				(listing) =>
					listing?.flatMap((entry) => {
						if (entry.stem !== stem) return [entry];
						if (nextStem === undefined) return [];
						const result =
							entry.result.error === null
								? Ok({ ...entry.result.data, path: to })
								: entry.result;
						return [{ stem: nextStem, result }];
					}),
			);
		queryClient.removeQueries({ queryKey: textKey(from), exact: true });
		rowDrafts.delete(from);
		textEdits.delete(from);
		if (asText.delete(from)) asText.add(to);
		if (selectedPath === from) selectedPath = to;
	}

	/** After a delete: the caches, the edits, and the selection let the file go. */
	function deleted(path: string) {
		for (const table of [
			RECORDINGS,
			TRANSCRIPTIONS,
			TRANSFORMATIONS,
			TRANSFORMATION_RUNS,
			TEXT_RUNS,
		] as const) {
			const stem = rowStemOf(table, path);
			if (stem !== undefined)
				queryClient.setQueryData<TableListing<unknown>>(
					optionsOf(table).list.queryKey(),
					(listing) => listing?.filter((entry) => entry.stem !== stem),
				);
		}
		queryClient.removeQueries({ queryKey: textKey(path), exact: true });
		rowDrafts.get(path)?.discard();
		rowDrafts.delete(path);
		textEdits.delete(path);
		asText.delete(path);
		if (selectedPath === path) selectedPath = undefined;
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
	}

	/**
	 * Run `work` as a mutation, so closing waits for it. `scope`
	 * names the file whose queue a write joins: a recording's lifecycle steps
	 * run in order, and the folder is read again after each. Work with no
	 * scope only reads.
	 */
	async function track<T>(work: () => Promise<T>, scope?: string): Promise<T> {
		const ran = await defineMutation({
			mutationKey:
				scope === undefined ? keys.action('read') : keys.recording(scope),
			...(scope !== undefined && { scope: { id: scope } }),
			mutationFn: async () => Ok(await work()),
			onSettled: () => (scope === undefined ? undefined : invalidate()),
		})();
		if (ran.error !== null) throw ran.error;
		return ran.data as T;
	}

	// --- connections, microphone, terminal ---------------------------------------

	/** What the device has set up, never a key; undefined until read or when the read failed. */
	let connections = $state.raw<ConnectionsInfo | undefined>();
	let connectionsError = $state<string | undefined>();

	function resolve(recipe: RecipeRow | undefined): ResolvedRecipe {
		return resolveRecipe(recipe, connections?.text, connectionsError);
	}

	async function readConnections() {
		try {
			connections = await workspace.connections.read();
			connectionsError = undefined;
		} catch (cause) {
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
	/** The start that has not answered yet. Aborting it releases a microphone that opens late. */
	let starting: AbortController | undefined;
	/** Folders open in the file browser; kept while the browser is hidden. */
	const expanded = new SvelteSet<string>([RECORDINGS]);
	/** Recordings whose deletion is under way. No request starts for one. */
	const deleting = new Set<string>();
	/** Told the recording files a listing found, each time one is read. */
	const recordingsListed = new Set<(present: ReadonlySet<string>) => void>();
	const recordingsHash = hashKey(optionsOf(RECORDINGS).list.queryKey());
	const stopListening = queryClient.getQueryCache().subscribe((event) => {
		if (event.type !== 'updated' || event.action.type !== 'success') return;
		if (event.query.queryHash !== recordingsHash) return;
		const read = recordingsRead();
		if (read === undefined) return;
		for (const listener of recordingsListed) listener(read.paths);
	});

	const runs = createRuns({
		workspace,
		makeId: recordingId,
		refused,
		connections: () => ({ info: connections, error: connectionsError }),
		resolve,
		settle: writesSettled,
		deleting,
		capturing,
		track,
	});

	/** A terminal command may write anything, so it is a mutation, and everything is read again after it. */
	const runCommand = defineMutation({
		mutationKey: keys.action('terminal'),
		mutationFn: async ({
			shell,
			command,
			options,
		}: {
			shell: WorkspaceTerminal;
			command: string;
			options?: { signal?: AbortSignal };
		}) => Ok(await shell.exec(command, options)),
	});
	const shell = workspace.terminal;
	const terminal =
		shell === undefined
			? undefined
			: createTerminalSession(
					{
						get cwd() {
							return shell.cwd;
						},
						async exec(command, options) {
							const why = refused();
							if (why !== undefined) throw new Error(why);
							// A command that throws is shown in the terminal's output.
							const ran = await runCommand({ shell, command, options });
							if (ran.error !== null) throw ran.error;
							return ran.data as TerminalResult;
						},
					},
					() => invalidate(),
				);
	const input = createMicrophoneInput({
		capture: workspace.capture,
		preferences: workspace.preferences,
		recording: () => recorder.phase !== 'idle',
	});

	/** Show `path`: a transformation on its page, anything else beside the recordings. Opening never waits or asks. */
	function open(path: string) {
		if (closing) return;
		for (const ancestor of ancestorsOf(path)) expanded.add(ancestor);
		if (rowTableOf(path) === TRANSFORMATIONS) selectedTransformationPath = path;
		else selectedPath = path;
	}

	// --- recording ----------------------------------------------------------

	/** The folder a capture writes its audio into. */
	const recordingFolder = (): RecordingFolder => ({
		id: WHISPERING_FOLDER_ID,
		files: folder.files,
	});

	/** One write of a recording, through a debug shell's armed failure when there is one. */
	const recordingWrite: RecordingWriteHook = (write, run) =>
		workspace.injection?.aroundRecordingWrite(write, run) ?? run();

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
		const stopping = recordingWrite(
			{ step: 'audio', stem: id, path: capture.audioPath },
			() => capture.stop(),
		);
		const { data: stopped, error: stopError } = await track(() => stopping);
		capturing.delete(id);
		recorder = { phase: 'idle' };
		if (stopError !== null) {
			recorderError = stopError.message;
			return;
		}
		const lengthError = await track(async () => {
			const { data: stored, error } = await tableOf(RECORDINGS).get(id);
			if (error !== null) return describeError(error);
			if (stored === undefined) return undefined;
			const { error: replaceError } = await tableOf(RECORDINGS).save(stored, {
				fields: { ...stored.row.fields, durationMs: stopped.durationMs },
				body: stored.row.body,
			});
			return replaceError === null ? undefined : describeError(replaceError);
		}, path);
		if (lengthError !== undefined)
			recorderError = `The recording is saved, but its length could not be written: ${lengthError}`;
		if (selectedPath === selectionBefore) open(path);
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		listing: queryClient.getQueryData<FileListing>(
			folder$.files.list.queryKey(),
		),
		writesSettled,
		held: heldCapture,
		busy: (id) =>
			deleting.has(id) ? 'This recording is being deleted.' : runs.busy(id),
		audioOf: (path) => {
			const entry = entries().find(
				(item) => audioPathIn(item.row.fields) === path,
			);
			return entry && recordingTitle(entry);
		},
	});

	/** An action that does not start while closing; answers what the person is told. */
	function action<TArgs extends unknown[]>(
		name: string,
		work: (...args: TArgs) => Promise<string | undefined>,
		onSettled: () => unknown = () => invalidate(),
	) {
		const mutation = defineMutation({
			mutationKey: keys.action(name),
			mutationFn: async (args: TArgs) => Ok(await work(...args)),
			onSettled,
		});
		return async (...args: TArgs): Promise<string | undefined> => {
			// Refused when asked; once accepted, it runs, and closing waits for it.
			const why = refused();
			if (why !== undefined) return why;
			const ran = await mutation(args);
			return ran.error === null ? (ran.data ?? undefined) : describe(ran.error);
		};
	}

	const saveConnection = action(
		'save-connection',
		async (operation: Operation, change: ConnectionChange) => {
			const { data: saved, error } = await workspace.connections.set(
				operation,
				change,
			);
			if (error !== null) return error;
			connections = saved;
			connectionsError = undefined;
			return undefined;
		},
		() => undefined,
	);

	const kvReading = () => {
		trackQueries();
		return (
			queryClient.getQueryData<KvReading<LegacySettings> | null>(
				folder$.kv.get.queryKey(),
			) ?? undefined
		);
	};

	return {
		workspace,
		folder,
		queryClient,
		terminal,
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
			const listing = listed(TRANSCRIPTIONS);
			return listing ? transcriptionsOf(listing) : [];
		},
		get listError() {
			return readError(optionsOf(RECORDINGS).list.queryKey());
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			trackQueries();
			return queryClient.getQueryData<FileListing>(
				folder$.files.list.queryKey(),
			);
		},
		get listingError() {
			return readError(folder$.files.list.queryKey());
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
			return kvReading()?.values ?? {};
		},
		/** Why `kv.json` could not be read, or what in it does not conform. */
		get settingsProblem() {
			const error = readError(folder$.kv.get.queryKey());
			if (error !== undefined) return error;
			const kv = kvReading();
			if (kv === undefined || kv.issues.length === 0) return undefined;
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

		// ------------------------------------------------------------------
		// Selection
		// ------------------------------------------------------------------

		get selectedPath() {
			return selectedPath;
		},
		/**
		 * What the recordings page shows. A recording the listing no longer has
		 * is no selection: it was deleted, here or elsewhere.
		 */
		get selection(): Selection | undefined {
			const path = selectedPath;
			if (path === undefined) return undefined;
			if (rowTableOf(path) !== RECORDINGS)
				return { kind: 'file', path, entry: undefined };
			const read = recordingsRead();
			if (read !== undefined && !read.paths.has(path)) return undefined;
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
			const listing = listed(TRANSFORMATIONS);
			const read = listing && transformationsOf(listing);
			if (read !== undefined && !read.paths.has(path)) return undefined;
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
		// Edits and writes
		// ------------------------------------------------------------------

		textQuery,
		/**
		 * The row of `table` at `path` as shown, read reactively: the edit
		 * while one is unsaved, else the row the cache holds, if it reads.
		 */
		rowAt<T extends RowTable>(
			table: T,
			path: string,
		): Row<Tables[T]> | undefined {
			const edited = rowDrafts.get(path)?.row;
			if (edited !== undefined) return edited as Row<Tables[T]>;
			const stem = rowStemOf(table, path);
			if (stem === undefined) return undefined;
			const result = listed(table)?.find(
				(entry) => entry.stem === stem,
			)?.result;
			return result?.error === null ? result.data.row : undefined;
		},
		/** The text typed into `path` that is not written yet, read reactively. */
		editedText(path: string): string | undefined {
			return textEdits.get(path)?.text;
		},
		/** Whether `path` shows as its exact text rather than its fields. */
		showsText(path: string) {
			return showsText(path);
		},
		/**
		 * Change the row at `stem` and save it. The first change captures the
		 * row the cache holds as the version the edit started from; the edit
		 * is saved over it, merged with whatever changed since, one save at a
		 * time. Refused, changing nothing, while closing, and while a rename
		 * or delete of the file runs. Inputs commit only values the schema
		 * accepts.
		 */
		editRow<T extends RowTable>(
			table: T,
			stem: string,
			change: (row: Row<Tables[T]>) => void,
		): void {
			const path = rowPath(table, stem);
			if (refused() !== undefined || moving(path)) return;
			const held = rowDrafts.get(path);
			const current =
				(rowOf(table, stem) as StoredRow<Fields> | undefined) ?? held?.base;
			if (current === undefined) return;
			const draft = held ?? rowDraft(table, path);
			draft.change(current, change as (row: Row<Fields>) => void);
			void draft.save();
		},
		/** Replace the text of `path` and write it, over the version the edit started from. */
		editText(path: string, text: string): void {
			if (refused() !== undefined || moving(path)) return;
			const opened = textData(path);
			// The first change starts from the file shown; later ones keep their base.
			const base =
				textEdits.get(path)?.base ??
				(opened?.kind === 'text' ? opened.file : undefined);
			if (base === undefined) return;
			textEdit(path).change(base, text);
			void saveText(path);
		},
		/** Hear what an edit's write did that the person is told: it failed, or it replaced another writer's change. */
		onWriteNotice(listener: (notice: WriteNotice) => void): () => void {
			noticeListeners.add(listener);
			return () => noticeListeners.delete(listener);
		},
		/** Whether a write of `path` is running, read reactively. */
		isSaving(path: string) {
			return (
				(rowDrafts.get(path)?.saving ?? false) ||
				(textEdits.get(path)?.saving ?? false)
			);
		},
		/** Whether a write of any file is running, read reactively. */
		get saving() {
			return (
				[...rowDrafts.values()].some((draft) => draft.saving) ||
				[...textEdits.values()].some((draft) => draft.saving)
			);
		},
		/** Whether an edit is not in its file yet: being written, or kept after its write failed. */
		get unsaved() {
			return (
				[...rowDrafts.values()].some((draft) => draft.row !== undefined) ||
				[...textEdits.values()].some((draft) => draft.text !== undefined)
			);
		},
		/** Whether input is refused now: while closing, or while `path` is renamed or deleted. */
		locked(path?: string) {
			trackMutations();
			return closing || (path !== undefined && moving(path));
		},
		/**
		 * Edit a row file's whole text instead of its fields. Its writes land
		 * first, and its text is read then. Answers why not.
		 */
		async editSource(path: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			await writesSettled();
			await queryClient
				.fetchQuery({ ...textQuery(path), staleTime: 0 })
				.catch(() => undefined);
			asText.add(path);
			return undefined;
		},
		/**
		 * Edit a row file's fields again after editing its text. Its writes
		 * land, and its row is read then. Text that does not read as a row
		 * stays as text, and this says so.
		 */
		async useForm(path: string): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const table = rowTableOf(path);
			if (table === undefined) return undefined;
			const opened = textData(path);
			const typed =
				textEdits.get(path)?.text ??
				(opened?.kind === 'text' ? opened.file.text : undefined);
			if (
				typed !== undefined &&
				parseRow(whisperingDefinition.tables[table], typed).error !== null
			)
				return STILL_TEXT;
			await writesSettled();
			await queryClient
				.fetchQuery({ ...listingOf(table), staleTime: 0 })
				.catch(() => undefined);
			const stem = rowStemOf(table, path);
			const result = listed(table)?.find(
				(entry) => entry.stem === stem,
			)?.result;
			if (result !== undefined && result.error !== null) return STILL_TEXT;
			asText.delete(path);
			return undefined;
		},

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

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

		// ------------------------------------------------------------------
		// Reads on request
		// ------------------------------------------------------------------

		/** Read the folder again, as after a read that failed. */
		readAgain: () => invalidate(),
		/**
		 * First read after opening: repair recordings a quit or a crash cut
		 * off, then the folder, then what this device has set up. Nothing is
		 * created and nothing is sent.
		 */
		async start() {
			const { error: recoverError } = await recoverRecordings({
				folder: recordingFolder(),
				under: RECORDINGS,
			});
			if (recoverError !== null)
				recorderError = `Recordings a quit cut off could not be checked: ${recoverError.message}`;
			// A read that answers with an error is shown as that listing's
			// problem; one that throws means the folder cannot be read at all,
			// and the opening fails with it.
			const thrown: unknown[] = [];
			await Promise.all(
				shownQueries().map((options) =>
					queryClient
						.fetchQuery({
							...(options as unknown as QueryOptions),
							queryFn: async (context) => {
								try {
									return await (options as unknown as QueryOptions).queryFn(
										context,
									);
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
			// Observed from now on, so what the folder reports changed is read again.
			stopObserving = shownQueries().map((options) =>
				new QueryObserver(queryClient, options as QueryOptions).subscribe(
					() => {},
				),
			);
			await readConnections();
			// The saved choice only: no microphone is opened or listed at launch.
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
			const listing = listed(TRANSCRIPTIONS);
			return byNewest(
				(listing ? transcriptionsOf(listing) : []).filter(
					(entry) => entry.row.fields.recordingId === id,
				),
			);
		},
		/** Transformations that read, by title. */
		get transformations() {
			const listing = listed(TRANSFORMATIONS);
			return listing ? transformationsOf(listing).entries : [];
		},
		get transformationsError() {
			return readError(optionsOf(TRANSFORMATIONS).list.queryKey());
		},
		/** Transformation files that do not read as transformations, with why. */
		get transformationRepairs() {
			const listing = listed(TRANSFORMATIONS);
			return listing ? transformationsOf(listing).repairs : [];
		},
		isTransformation(path: string) {
			const listing = listed(TRANSFORMATIONS);
			return listing ? transformationsOf(listing).paths.has(path) : false;
		},
		get transformationResults() {
			const listing = listed(TRANSFORMATION_RUNS);
			return byNewest(listing ? resultsOf(listing) : []);
		},
		/** Saved results made from one transcription, newest first. */
		outputsFor(transcriptionId: string): TransformationRunEntry[] {
			const listing = listed(TRANSFORMATION_RUNS);
			return byNewest(
				(listing ? resultsOf(listing) : []).filter(
					(entry) => entry.row.fields.transcriptionId === transcriptionId,
				),
			);
		},
		/** Saved results one transformation produced, newest first. They outlive it. */
		outputsOf(transformationId: string): TransformationRunEntry[] {
			const listing = listed(TRANSFORMATION_RUNS);
			return byNewest(
				(listing ? resultsOf(listing) : []).filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		/** Saved results on pasted text one recipe produced, newest first. */
		textOutputsOf(transformationId: string): TextRunEntry[] {
			const listing = listed(TEXT_RUNS);
			return byNewest(
				(listing ? textResultsOf(listing).entries : []).filter(
					(entry) => entry.row.fields.transformationId === transformationId,
				),
			);
		},
		get textResultsError() {
			return readError(optionsOf(TEXT_RUNS).list.queryKey());
		},
		/** Files in `text_runs/` that do not read as results. */
		get textRepairs() {
			const listing = listed(TEXT_RUNS);
			return listing ? textResultsOf(listing).repairs : [];
		},
		/** Changes each time the folder listing is read; audio players recheck their file on it. */
		get generation() {
			trackQueries();
			return (
				queryClient.getQueryState(folder$.files.list.queryKey())
					?.dataUpdateCount ?? 0
			);
		},
		/** The recording whose row names `path` as its audio, if one does. */
		recordingNaming(path: string): RecordingEntry | undefined {
			return entries().find((entry) => audioPathIn(entry.row.fields) === path);
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
				await workspace.capture.start({
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
			const created = await track(
				() =>
					recordingWrite({ step: 'row', stem: id }, () =>
						tableOf(RECORDINGS).create(
							{
								fields: {
									title: defaultTitle(at),
									recordedAt: InstantString.fromDate(at),
									capture: workspace.capture.source,
									audioPath: capture.audioPath,
								},
								body: '',
							},
							{ stem: id },
						),
					),
				rowPath(RECORDINGS, id),
			);
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
			await track(
				async () => {
					const { data: stored } = await tableOf(RECORDINGS).get(id);
					if (stored !== undefined && stored !== null)
						await tableOf(RECORDINGS).delete(stored);
				},
				rowPath(RECORDINGS, id),
			);
			deleted(rowPath(RECORDINGS, id));
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
		 * A new recipe file: a title and instructions. It names no endpoint and
		 * no model of its own (`null`), so it runs with the text connection.
		 */
		createTransformation: action(
			'create-transformation',
			async ({ title, prompt }: { title: string; prompt: string }) => {
				const { data: created, error } = await tableOf(TRANSFORMATIONS).create({
					fields: { title, model: null, endpoint: null },
					body: prompt,
				});
				if (error !== null) return describeError(error);
				const stem = rowStemOf(TRANSFORMATIONS, created.path);
				if (stem !== undefined)
					queryClient.setQueryData<TableListing<TransformationFields>>(
						optionsOf(TRANSFORMATIONS).list.queryKey(),
						(listing) => listing && [...listing, { stem, result: Ok(created) }],
					);
				open(created.path);
				return undefined;
			},
		),
		deleteTransformationResult: action(
			'delete-result',
			async (entry: TransformationRunEntry) => {
				const { error } = await tableOf(TRANSFORMATION_RUNS).delete(entry);
				if (error !== null) return describeError(error);
				deleted(entry.path);
				return undefined;
			},
		),
		deleteTextResult: action(
			'delete-text-result',
			async (entry: TextRunEntry) => {
				const { error } = await tableOf(TEXT_RUNS).delete(entry);
				if (error !== null) return describeError(error);
				deleted(entry.path);
				return undefined;
			},
		),

		/**
		 * Save one connection on this device. Nothing is sent to the endpoint
		 * and nothing is written to the folder.
		 */
		saveConnection,
		/** Move the key an earlier build saved into the chosen connections. */
		adoptLegacyKey: action(
			'adopt-legacy-key',
			async (targets: LegacyKeyTargets) => {
				const { data: adopted, error } =
					await workspace.connections.adoptLegacyKey(targets);
				if (error !== null) return error;
				connections = adopted;
				connectionsError = undefined;
				return undefined;
			},
			() => undefined,
		),
		/** Read the connections again, as after a failed read. */
		readConnections,

		/**
		 * Rename a file within its folder. Recording and transformation files
		 * keep their names, and so does audio a recording names. The edits
		 * being written land first, and it moves what the last one confirmed;
		 * edits of the file wait meanwhile.
		 */
		async rename(path: string, name: string): Promise<string | undefined> {
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
			if (entries().some((entry) => audioPathIn(entry.row.fields) === path))
				return RECORDING_AUDIO_NAME;
			const stem = rowStemOf(TRANSCRIPTIONS, path);
			const nextStem = rowStemOf(TRANSCRIPTIONS, to);
			if (stem !== undefined && nextStem === undefined && !showsText(path))
				return TRANSCRIPT_NAME;
			const moving = await defineMutation({
				mutationKey: keys.move(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<FileCapture, FileError | MoveError | TableError | string>
				> => {
					await writesSettled();
					let capture = heldCapture(path);
					if (capture === undefined) {
						const { data: read, error } = await folder.files.read(path);
						if (error !== null) return Err(error);
						capture = { path: read.path, sha256: read.sha256 };
					}
					return stem !== undefined && nextStem !== undefined
						? tableOf(TRANSCRIPTIONS).rename(capture, nextStem)
						: folder.files.move(capture, to);
				},
				onSuccess: () => moved(path, to),
				onSettled: () => invalidate(),
			})();
			if (moving.error === null) return undefined;
			return typeof moving.error === 'string'
				? moving.error
				: describeError(moving.error);
		},
		/** A new empty text file, shown; it never replaces an existing one. */
		createFile: action(
			'create-file',
			async (directory: string, name: string) => {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				const listing = queryClient.getQueryData<FileListing>(
					folder$.files.list.queryKey(),
				);
				if (listing?.directories.includes(path))
					return `"${name}" already exists here.`;
				const { error } = await folder.files.create(path, '');
				if (error !== null) return describeError(error);
				open(path);
				return undefined;
			},
		),
		createFolder: action(
			'create-folder',
			async (directory: string, name: string) => {
				const problem = nameProblem(directory, name);
				if (problem !== undefined) return problem;
				const path = joinPath(directory, name);
				const listing = queryClient.getQueryData<FileListing>(
					folder$.files.list.queryKey(),
				);
				if (
					listing?.directories.includes(path) ||
					listing?.files.some((file) => file.path === path)
				)
					return `"${name}" already exists here.`;
				const { error } = await folder.files.mkdir(path);
				if (error !== null) return describeError(error);
				if (directory !== '') expanded.add(directory);
				return undefined;
			},
		),
		/**
		 * Capture what deleting `path` would remove, for the person to confirm.
		 * Queued writes land first.
		 */
		async deletionFor(path: string): Promise<Result<Deletion, string>> {
			const why = refused();
			if (why !== undefined) return Err(why);
			return captureDeletion(deletionContext(), path);
		},
		/**
		 * Delete exactly what was confirmed, after the edits being written
		 * land: what this window saved since goes with it, and a file another
		 * program changed since is refused.
		 */
		async remove(deletion: Deletion): Promise<string | undefined> {
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
			const path =
				deletion.kind === 'folder'
					? deletion.path
					: deletion.kind === 'recording'
						? deletion.row.path
						: deletion.file.path;
			const removed = await defineMutation({
				mutationKey: keys.remove(path),
				scope: { id: path },
				mutationFn: async () => {
					// Typed while the person was asked: written first, and deleted with it.
					await writesSettled();
					return Ok(
						await removeDeletion(
							{
								...deletionContext(),
								deleting,
								dropFailed: runs.dropFailed,
								deleted,
							},
							deletion,
						),
					);
				},
				onSettled: () => invalidate(),
			})();
			return removed.error === null
				? (removed.data ?? undefined)
				: describe(removed.error);
		},
		/**
		 * Record a version: commit the saved files (ADR-0529). Writes still
		 * running land first. Nothing else commits.
		 */
		async saveVersion(): Promise<CommitOutcome> {
			const why = refused();
			if (why !== undefined) return { status: 'blocked', reason: why };
			const saved = await defineMutation({
				mutationKey: keys.action('save-version'),
				mutationFn: async () => {
					await writesSettled();
					return Ok(await folder.git.commit());
				},
				onSettled: () =>
					queryClient.invalidateQueries({
						queryKey: folder$.history.status.queryKey(),
					}),
			})();
			return saved.error === null
				? (saved.data as CommitOutcome)
				: { status: 'failed', error: describe(saved.error) };
		},
		/**
		 * Stop new work, finish a recording that is running, write the edits,
		 * wait until nothing is mutating, then release the folder. An answer whose file could not
		 * be written ends with the page, and its row stays unfinished.
		 */
		async close() {
			closing = true;
			runs.stop();
			// The microphone first: nothing still being written may keep it open.
			input.close();
			starting?.abort();
			starting = undefined;
			// Kept, never deleted: a recording is in the folder from its start.
			await finishRecording();
			await writesSettled();
			await whenIdle(queryClient);
			await input.saved();
			stopChanges();
			for (const stop of stopObserving) stop();
			await queryClient.cancelQueries({ queryKey: folder$.key });
			stopListening();
			recordingsListed.clear();
			noticeListeners.clear();
			await workspace.close();
		},
	};
}
