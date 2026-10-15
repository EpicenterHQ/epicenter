/**
 * The Whispering product state over one opened workspace, kept in a TanStack
 * Query cache (ADR-0528).
 *
 * Reads are queries: each table's rows (`table.list()`), the listing the
 * file browser shows, `kv.json`, and the text of each file opened as text.
 * They are read when the page opens, when the person returns to the window,
 * and after the app's own actions and terminal commands. Nothing follows the
 * folder's change reports. Rows that read are listed to edit; the rest are
 * named, with why, for repair as text.
 *
 * An edit goes straight into the cache: one immutable `map` over a listing
 * changes one row, and one replacement changes a file's text. Each edit is
 * written by a mutation scoped to its file, so writes to one file run one at
 * a time while writes to different files run side by side. A write reads the
 * cache when it runs, so it saves the newest row and is guarded by the newest
 * confirmed `sha256`; a file has at most one write running and one waiting.
 * A write that fails reads that file again, which rolls the edit back, and is
 * reported with the text that was lost. A row deleted elsewhere stays
 * deleted: its write fails, and nothing creates it again.
 *
 * Every other action is a mutation too: a recording's row and its length,
 * writing a transcript or a result (scoped by the recording's file, so they
 * write in order), create, rename, delete, Save version, settings, and
 * terminal commands. Closing stops new work, then waits until nothing is
 * mutating. Saves never commit (ADR-0529); a version is recorded only by
 * Save version.
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
	FileTable,
	KvReading,
	MoveError,
	Row,
	RowReadError,
	SavedRow,
	StoredRow,
	TableError,
	TableListing,
	TableSaveError,
} from '@epicenter/folder';
import { formatRow, parseRow, rowPath, rowStemOf } from '@epicenter/folder';
import {
	ancestorsOf,
	dirname,
	joinPath,
	type OpenedFile,
} from '@epicenter/folder/file-browser';
import { createSaveBases } from '@epicenter/folder/query';
import { type RecordingFolder, recoverRecordings } from '@epicenter/recorder';
import type {
	MutationFilters,
	MutationOptions,
	QueryClient,
	QueryFunctionContext,
} from '@tanstack/svelte-query';
import { customAlphabet } from 'nanoid';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import {
	createQueryFactories,
	defineKeys,
	resultMutationOptions,
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

/** A write that failed and was rolled back to the file. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError;
	/** The text that was in the editor and is not in the file. */
	readonly lost: string;
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

/** Cache identity for every query and mutation the app runs. */
export const whisperingKeys = defineKeys({
	/** Every query the app keeps; read again after the app's own actions. */
	all: ['whispering'],
	/** The listings every page shows: the tables, the files, and `kv.json`. */
	lists: ['whispering', 'list'],
	rows: (table: TableName) => ['whispering', 'list', 'rows', table] as const,
	files: ['whispering', 'list', 'files'],
	kv: ['whispering', 'list', 'kv'],
	text: (path: string) => ['whispering', 'text', path] as const,
	/** Every write of a row or a file's text. */
	writes: ['whispering', 'write'],
	write: (path: string) => ['whispering', 'write', 'row', path] as const,
	writeText: (path: string) => ['whispering', 'write', 'text', path] as const,
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
 * Resolves once nothing matching `filters` is mutating. It watches the
 * mutation cache, so a mutation that starts meanwhile is waited for too.
 */
export function whenIdle(
	queryClient: QueryClient,
	filters?: MutationFilters,
): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating(filters) > 0) return;
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
	const { defineMutation } = createQueryFactories(queryClient);
	const tableOf = <T extends TableName>(name: T) =>
		folder.tables[name] as unknown as FileTable<Tables[T]>;

	let closing = $state(false);

	/** Why nothing new starts now, if it does not. Work accepted before stays accepted. */
	function refused(): string | undefined {
		return closing ? CLOSING : undefined;
	}

	// Every read and write is local: nothing waits for a network, and a read
	// or write that failed is shown rather than retried.
	queryClient.setQueryDefaults(keys.all, {
		networkMode: 'always',
		retry: false,
		// Nothing goes stale on its own: a view that mounts shows what the cache
		// holds, and reads happen only when asked for, never while a write runs.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: () => (writing() ? false : 'always'),
	});
	// Every page shows the listings, whether or not a view observes them now.
	queryClient.setQueryDefaults(keys.lists, {
		gcTime: Number.POSITIVE_INFINITY,
	});
	queryClient.setMutationDefaults(keys.all, {
		networkMode: 'always',
		retry: false,
	});

	const trackQueries = createSubscriber((update) =>
		queryClient.getQueryCache().subscribe(update),
	);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));

	/** Whether a write of a row or a file's text is running or waiting. */
	const writing = () =>
		queryClient.isMutating({ mutationKey: keys.writes }) > 0;
	/** Resolves once no write of a row or a file's text is running or waiting. */
	const writesSettled = () =>
		whenIdle(queryClient, { mutationKey: keys.writes });

	// --- reads -----------------------------------------------------------------

	function rowsQuery<T extends TableName>(table: T) {
		return resultQueryOptions({
			queryKey: keys.rows(table),
			queryFn: () => tableOf(table).list(),
		});
	}
	const filesQuery = () =>
		resultQueryOptions({
			queryKey: keys.files,
			queryFn: () => folder.files.list(),
		});
	/** `kv.json` as read, or null when the folder has none. */
	const kvQuery = () =>
		resultQueryOptions({
			queryKey: keys.kv,
			queryFn: async () => {
				const read = await folder.kv.get();
				return read.error === null ? Ok(read.data ?? null) : read;
			},
		});
	/**
	 * One file's complete text, or its type and size when it is not editable
	 * text. The same options object for each path, so a view that asks again
	 * does not change its query's options.
	 */
	const textQueries = new Map<string, ReturnType<typeof textQueryOf>>();
	const textQueryOf = (path: string) =>
		resultQueryOptions({
			queryKey: keys.text(path),
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
	const listingQueries = () => [
		rowsQuery(RECORDINGS),
		rowsQuery(TRANSCRIPTIONS),
		rowsQuery(TRANSFORMATIONS),
		rowsQuery(TRANSFORMATION_RUNS),
		rowsQuery(TEXT_RUNS),
		filesQuery(),
		kvQuery(),
	];

	/** A listing as the cache holds it, read reactively. */
	function listed<T extends TableName>(table: T) {
		trackQueries();
		return queryClient.getQueryData<TableListing<Tables[T]>>(keys.rows(table));
	}
	/** Why the last read of a query failed, read reactively. */
	function readError(queryKey: readonly unknown[]): string | undefined {
		trackQueries();
		return queryClient.getQueryState(queryKey)?.error?.message;
	}
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(keys.text(path));

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

	// --- the cache's rows and text ---------------------------------------------

	/** The row the cache holds for `stem`, if it reads. */
	function rowOf<T extends RowTable>(
		table: T,
		stem: string,
	): StoredRow<Tables[T]> | undefined {
		const result = queryClient
			.getQueryData<TableListing<Tables[T]>>(keys.rows(table))
			?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Change the row at `stem` in the cache: one immutable `map` over the listing. */
	/**
	 * The row each cached version held, by path, which a save merges from.
	 * Every table's rows share it: a path names one table's row.
	 */
	const bases = createSaveBases<Record<string, unknown>>();

	function mapRow<T extends RowTable>(
		table: T,
		stem: string,
		change: (stored: StoredRow<Tables[T]>) => StoredRow<Tables[T]>,
	): boolean {
		let changed = false;
		queryClient.setQueryData<TableListing<Tables[T]>>(
			keys.rows(table),
			(listing) =>
				listing?.map((entry) => {
					if (entry.stem !== stem || entry.result.error !== null) return entry;
					changed = true;
					return { ...entry, result: Ok(change(entry.result.data)) };
				}),
		);
		return changed;
	}

	/** Change the text of `path` in the cache, if it holds text. */
	function mapText(
		path: string,
		change: (file: { path: string; sha256: string; text: string }) => {
			path: string;
			sha256: string;
			text: string;
		},
	): boolean {
		let changed = false;
		queryClient.setQueryData<OpenedFile>(keys.text(path), (opened) => {
			if (opened?.kind !== 'text') return opened;
			changed = true;
			return { kind: 'text', file: change(opened.file) };
		});
		return changed;
	}

	/** The text a person loses with a row that could not be written. */
	function rowText<T extends RowTable>(table: T, row: Row<Tables[T]>) {
		const formatted = formatRow(
			whisperingDefinition.tables[table] as never,
			row as never,
		) as Result<string, unknown>;
		return formatted.data ?? row.body;
	}

	/**
	 * Read one row file into the cache as the file holds it now: gone when
	 * the file is gone, added when the listing has not seen it. After a failed
	 * write, TanStack awaits this before the next write of the file runs, so
	 * that write saves the file's own bytes.
	 */
	async function reloadRow(table: RowTable, stem: string) {
		await queryClient.cancelQueries({
			queryKey: keys.rows(table),
			exact: true,
		});
		const { data: stored, error } = await tableOf(table).get(stem);
		const read =
			error !== null
				? { stem, result: Err(error) }
				: stored === undefined
					? undefined
					: { stem, result: Ok(stored) };
		queryClient.setQueryData<TableListing<unknown>>(
			keys.rows(table),
			(listing) => {
				if (listing === undefined) return listing;
				const others = listing.filter((entry) => entry.stem !== stem);
				if (read === undefined) return others;
				// A file the listing has not seen yet joins it.
				return others.length === listing.length
					? [...listing, read]
					: listing.map((entry) => (entry.stem === stem ? read : entry));
			},
		);
	}

	/** After a failed write of a file's text, the cache takes the file as it is now. */
	async function reloadText(path: string) {
		const key = keys.text(path);
		await queryClient.cancelQueries({ queryKey: key, exact: true });
		const read = await readTextFile(folder.files, path);
		if (read.error === null) queryClient.setQueryData(key, read.data);
		else
			await queryClient.invalidateQueries({
				queryKey: key,
				exact: true,
				refetchType: 'all',
			});
	}

	/**
	 * Read again what an action may have changed, and Git status with it.
	 * While a write runs nothing is read: the last write to settle reads
	 * everything again.
	 */
	async function invalidate(queryKey: readonly unknown[] = keys.all) {
		if (writing() || closing) return;
		await Promise.all([
			queryClient.invalidateQueries({ queryKey, refetchType: 'all' }),
			folder.git.status(),
		]);
	}

	/**
	 * After a write settles: once it is the last one, everything is read
	 * again. The write does not wait for that read; an edit made meanwhile
	 * cancels it.
	 */
	function afterWrite() {
		if (queryClient.isMutating({ mutationKey: keys.writes }) > 1 || closing)
			return;
		void queryClient.invalidateQueries({
			queryKey: keys.all,
			refetchType: 'all',
		});
		void folder.git.status();
	}

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
				.getQueryData<TableListing<unknown>>(keys.rows(table))
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

	const failureListeners = new Set<(failure: WriteFailure) => void>();
	function reportFailure(failure: WriteFailure) {
		for (const listener of failureListeners) listener(failure);
	}

	/**
	 * The write of one row: the newest row the cache holds when it runs,
	 * over the version the cache last confirmed, from the row that version
	 * held; a file changed elsewhere since is merged with it.
	 */
	function rowWrite<T extends RowTable>(table: T, stem: string) {
		const path = rowPath(table, stem);
		return resultMutationOptions({
			mutationKey: keys.write(path),
			// Row and text writes of one file share its queue.
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<SavedRow<Tables[T]> | undefined, TableSaveError>
			> => {
				const stored = rowOf(table, stem);
				if (stored === undefined) return Ok(undefined);
				const saved = await tableOf(table).save(
					bases.baseOf(path, stored) as FileCapture & {
						readonly row?: Row<Tables[T]>;
					},
					stored.row,
				);
				if (saved.error === null)
					bases.saved(
						path,
						stored.row as Row<Record<string, unknown>>,
						saved.data as SavedRow<Record<string, unknown>>,
					);
				return saved;
			},
			onSuccess: (saved) => {
				if (saved === undefined) return;
				// TanStack awaits this before the next write in the scope runs.
				mapRow(table, stem, (stored) => ({
					...stored,
					path: saved.stored.path,
					sha256: saved.stored.sha256,
				}));
			},
			onError: async (error) => {
				const lost = rowOf(table, stem);
				await reloadRow(table, stem);
				reportFailure({
					path,
					error,
					lost: lost === undefined ? '' : rowText(table, lost.row),
				});
			},
			onSettled: afterWrite,
		});
	}

	/** The write of one file's text, as `rowWrite` is for a row. */
	function textWrite(path: string) {
		return resultMutationOptions({
			mutationKey: keys.writeText(path),
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<FileCapture | undefined, FileError>
			> => {
				const opened = textData(path);
				if (opened?.kind !== 'text') return Ok(undefined);
				return folder.files.replace(opened.file, opened.file.text);
			},
			onSuccess: (saved) => {
				if (saved === undefined) return;
				mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
			},
			onError: async (error) => {
				const lost = textData(path);
				await reloadText(path);
				reportFailure({
					path,
					error,
					lost: lost?.kind === 'text' ? lost.file.text : '',
				});
			},
			onSettled: afterWrite,
		});
	}

	/** Run a mutation from its options now, as a view's `mutate` does. */
	function run(options: MutationOptions<unknown, unknown, void, unknown>) {
		void queryClient
			.getMutationCache()
			.build(queryClient, options)
			.execute(undefined)
			.catch(() => undefined);
	}

	/** After a rename: the caches and the selection follow the file. */
	function moved(from: string, to: string) {
		const stem = rowStemOf(TRANSCRIPTIONS, from);
		const nextStem = rowStemOf(TRANSCRIPTIONS, to);
		if (stem !== undefined)
			queryClient.setQueryData<TableListing<TranscriptionFields>>(
				keys.rows(TRANSCRIPTIONS),
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
		queryClient.removeQueries({ queryKey: keys.text(from), exact: true });
		if (asText.delete(from)) asText.add(to);
		if (selectedPath === from) selectedPath = to;
	}

	/** After a delete: the caches and the selection let the file go. */
	function deleted(path: string) {
		const table = rowTableOf(path);
		const stem = table && rowStemOf(table, path);
		if (table !== undefined && stem !== undefined)
			queryClient.setQueryData<TableListing<unknown>>(
				keys.rows(table),
				(listing) => listing?.filter((entry) => entry.stem !== stem),
			);
		for (const results of [TRANSFORMATION_RUNS, TEXT_RUNS] as const) {
			const resultStem = rowStemOf(results, path);
			if (resultStem !== undefined)
				queryClient.setQueryData<TableListing<unknown>>(
					keys.rows(results),
					(listing) => listing?.filter((entry) => entry.stem !== resultStem),
				);
		}
		queryClient.removeQueries({ queryKey: keys.text(path), exact: true });
		asText.delete(path);
		if (selectedPath === path) selectedPath = undefined;
		if (selectedTransformationPath === path)
			selectedTransformationPath = undefined;
	}

	/**
	 * Run `work` as a mutation, so closing waits for it. `scope`
	 * names the file whose queue a write joins: a recording's lifecycle steps
	 * run in order, after that file's queued writes, and the folder is read
	 * again after each. Work with no scope only reads.
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
	const stopListening = queryClient.getQueryCache().subscribe((event) => {
		if (event.type !== 'updated' || event.action.type !== 'success') return;
		const key = event.query.queryKey;
		if (key.length !== 4 || key[2] !== 'rows' || key[3] !== RECORDINGS) return;
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
		await reloadRow(RECORDINGS, id);
		if (selectedPath === selectionBefore) open(path);
	}

	const deletionContext = (): DeletionContext => ({
		folder,
		listing: queryClient.getQueryData<FileListing>(keys.files),
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
			queryClient.getQueryData<KvReading<LegacySettings> | null>(keys.kv) ??
			undefined
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
			return queryClient.isFetching({ queryKey: keys.lists }) > 0;
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
			return readError(keys.rows(RECORDINGS));
		},
		/** Every file and directory in the folder, as last listed. */
		get listing() {
			trackQueries();
			return queryClient.getQueryData<FileListing>(keys.files);
		},
		get listingError() {
			return readError(keys.files);
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
			const error = readError(keys.kv);
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

		rowsQuery,
		textQuery,
		/** The row of `table` at `path` as the cache holds it, if it reads; read reactively. */
		rowAt<T extends RowTable>(
			table: T,
			path: string,
		): StoredRow<Tables[T]> | undefined {
			const stem = rowStemOf(table, path);
			if (stem === undefined) return undefined;
			const result = listed(table)?.find(
				(entry) => entry.stem === stem,
			)?.result;
			return result?.error === null ? result.data : undefined;
		},
		/** Whether `path` shows as its exact text rather than its fields. */
		showsText(path: string) {
			return showsText(path);
		},
		/**
		 * Change the row at `stem` in the cache and write it. A write is queued
		 * only when fewer than two are running or waiting for that file: the
		 * waiting one saves whatever the cache holds when it runs. Refused,
		 * changing nothing, while closing, and while a rename or
		 * delete of the file runs. Inputs commit only values the schema accepts.
		 */
		editRow<T extends RowTable>(
			table: T,
			stem: string,
			change: (row: Row<Tables[T]>) => Row<Tables[T]>,
		): void {
			const path = rowPath(table, stem);
			if (refused() !== undefined || moving(path)) return;
			// A read still running could replace this edit when it lands.
			void queryClient.cancelQueries({
				queryKey: keys.rows(table),
				exact: true,
			});
			const changed = mapRow(table, stem, (stored) => {
				bases.editing(path, stored as StoredRow<Record<string, unknown>>);
				return { ...stored, row: change(stored.row) };
			});
			if (!changed) return;
			if (
				queryClient.isMutating({ mutationKey: keys.write(path), exact: true }) <
				2
			)
				run(rowWrite(table, stem) as never);
		},
		/** Replace the text of `path` in the cache and write it, as `editRow` does. */
		editText(path: string, text: string): void {
			if (refused() !== undefined || moving(path)) return;
			void queryClient.cancelQueries({
				queryKey: keys.text(path),
				exact: true,
			});
			if (!mapText(path, (file) => ({ ...file, text }))) return;
			if (
				queryClient.isMutating({
					mutationKey: keys.writeText(path),
					exact: true,
				}) < 2
			)
				run(textWrite(path) as never);
		},
		/** Hear each write that failed and was rolled back, with the text it lost. */
		onWriteFailed(listener: (failure: WriteFailure) => void): () => void {
			failureListeners.add(listener);
			return () => failureListeners.delete(listener);
		},
		/** Whether a write of `path` is running or waiting, read reactively. */
		isSaving(path: string) {
			trackMutations();
			return (
				queryClient.isMutating({
					predicate: (mutation) => mutation.options.scope?.id === path,
				}) > 0
			);
		},
		/** Whether a write of any file is running or waiting, read reactively. */
		get saving() {
			trackMutations();
			return writing();
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
			if (
				opened?.kind === 'text' &&
				parseRow(whisperingDefinition.tables[table], opened.file.text).error !==
					null
			)
				return STILL_TEXT;
			await writesSettled();
			await queryClient
				.fetchQuery({ ...rowsQuery(table), staleTime: 0 })
				.catch(() => undefined);
			const stem = rowStemOf(table, path);
			const result = queryClient
				.getQueryData<TableListing<unknown>>(keys.rows(table))
				?.find((entry) => entry.stem === stem)?.result;
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

		/** The person's "Check again", and returning to the window. */
		check: () => invalidate(),
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
			await Promise.all([
				...listingQueries().map((options) =>
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
				folder.git.status(),
			]);
			if (thrown.length > 0) throw thrown[0];
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
			return readError(keys.rows(TRANSFORMATIONS));
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
			return readError(keys.rows(TEXT_RUNS));
		},
		/** Files in `text_runs/` that do not read as results. */
		get textRepairs() {
			const listing = listed(TEXT_RUNS);
			return listing ? textResultsOf(listing).repairs : [];
		},
		/** Changes each time the folder listing is read; audio players recheck their file on it. */
		get generation() {
			trackQueries();
			return queryClient.getQueryState(keys.files)?.dataUpdatedAt ?? 0;
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
			else await reloadRow(RECORDINGS, id);
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
						keys.rows(TRANSFORMATIONS),
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
		 * keep their names, and so does audio a recording names. It runs after
		 * the file's queued writes and moves what the last one confirmed; edits
		 * of the file wait meanwhile.
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
				const listing = queryClient.getQueryData<FileListing>(keys.files);
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
				const listing = queryClient.getQueryData<FileListing>(keys.files);
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
		 * Delete exactly what was confirmed, after the file's queued writes; a
		 * file another program changed since is refused.
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
				mutationFn: async () =>
					Ok(
						await removeDeletion(
							{
								...deletionContext(),
								deleting,
								dropFailed: runs.dropFailed,
								deleted,
							},
							deletion,
						),
					),
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
				onSettled: () => folder.git.status(),
			})();
			return saved.error === null
				? (saved.data as CommitOutcome)
				: { status: 'failed', error: describe(saved.error) };
		},
		/**
		 * Stop new work, finish a recording that is running, wait until nothing
		 * is mutating, then release the folder. An answer whose file could not
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
			await whenIdle(queryClient);
			await input.saved();
			await queryClient.cancelQueries({ queryKey: keys.all });
			stopListening();
			recordingsListed.clear();
			failureListeners.clear();
			await workspace.close();
		},
	};
}
