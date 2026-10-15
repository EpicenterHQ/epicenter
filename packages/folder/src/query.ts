/**
 * `@epicenter/folder/query`: TanStack Query option factories over an opened
 * folder (ADR-0548).
 *
 * `folderOptions(folder)` mirrors the folder. Each read exposes
 * `.queryOptions()` and `.queryKey()`, each write `.mutationOptions()`, as
 * tRPC's option factories do, so a page composes them with TanStack itself:
 *
 * ```ts
 * const folder$ = folderOptions(folder);
 * createQuery(() => folder$.todos.list.queryOptions());
 * createQuery(() => folder$.todos.get.queryOptions('abc'));
 * createMutation(() => folder$.todos.save.mutationOptions());
 * ```
 *
 * Reads go through the engine, which parses and validates each file. A
 * write updates the cache from its own result: a save sets its row, so the
 * page that saved reads nothing back. Changes the page did not make arrive
 * on `folder.onFilesChanged`, and the app root wires them, once, to exactly
 * the queries they name:
 *
 * ```ts
 * folder.onFilesChanged((change) =>
 *   queryClient.invalidateQueries(folder$.pathFilter(change)),
 * );
 * ```
 *
 * The folder's channel is the one detector of outside changes, so apps turn
 * TanStack's own focus refetch off (`refetchOnWindowFocus: false`).
 *
 * Nothing here holds the query client: a mutation reaches the cache through
 * the client TanStack hands its callbacks. Importing this module opens
 * nothing.
 */
import type { CreateRowOf, KvOf } from '@epicenter/definition';
import type {
	InvalidateQueryFilters,
	Query,
	QueryClient,
} from '@tanstack/query-core';
import { resultMutationOptions, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileListing } from './boundary.js';
import type { CapturedFile, ContentCapture, FileCapture } from './capture.js';
import type { FolderDefinition } from './definition.js';
import type {
	FileError,
	FileSaveError,
	KvReadError,
	KvWriteError,
	MoveError,
	RowReadError,
	TableCreateError,
	TableDeleteError,
	TableEnumerationError,
	TableRenameError,
	TableSaveError,
} from './errors.js';
import type { FilesChanged, Folder } from './folder.js';
import type { SyncError } from './git/errors.js';
import type {
	CommitOutcome,
	FilesObservation,
	GitError,
} from './git/history.js';
import type { CommitSummary } from './git/objects.js';
import type { SyncOptions, SyncOutcome } from './git/sync.js';
import type { FileKv, KvReading } from './kv.js';
import { rowPath, rowStemOf } from './paths.js';
import type { Row } from './row-text.js';
import type { SavedFile } from './save-file.js';
import type { FileTable, SavedRow, StoredRow, TableListing } from './table.js';

export {
	createDraft,
	createTextDraft,
	type Draft,
	type SaveTextVariables,
	type TextDraft,
} from './draft.js';

/** `kv.json`, whose reading the `kv` query holds. */
const KV_PATH = 'kv.json';
/** How many commits `history.log` reads when the caller names no depth. */
const LOG_DEPTH = 50;

/** A read: TanStack options for `createQuery`, and the key they cache under. */
type QueryFactory<TArgs extends unknown[], TData, TError> = {
	queryOptions(
		...args: TArgs
	): ReturnType<
		typeof resultQueryOptions<TData, TError, TData, TData, readonly unknown[]>
	>;
	queryKey(...args: TArgs): readonly unknown[];
};

/** A write: TanStack options for `createMutation`. */
type MutationFactory<TVariables, TData, TError> = {
	mutationOptions(): ReturnType<
		typeof resultMutationOptions<TData, TError, TVariables>
	>;
};

/** What a row save sends: the version the edit started from, and the edited row. */
export type SaveRowVariables<TFields> = {
	/** The version the edit started from, with its content (see `table.save`). */
	readonly base: ContentCapture;
	readonly row: Row<TFields>;
};

export type TableOptions<TFields> = {
	readonly list: QueryFactory<[], TableListing<TFields>, TableEnumerationError>;
	/** `null` when no file is at the stem: TanStack keeps no `undefined`. */
	readonly get: QueryFactory<
		[stem: string],
		StoredRow<TFields> | null,
		RowReadError
	>;
	readonly create: MutationFactory<
		{ readonly row: Row<TFields>; readonly stem?: string },
		StoredRow<TFields>,
		TableCreateError
	>;
	readonly save: MutationFactory<
		SaveRowVariables<TFields>,
		SavedRow<TFields>,
		TableSaveError
	>;
	readonly rename: MutationFactory<
		{ readonly file: FileCapture; readonly stem: string },
		FileCapture,
		TableRenameError
	>;
	readonly delete: MutationFactory<FileCapture, undefined, TableDeleteError>;
};

export type KvOptions<TValues> = {
	/** `null` when there is no `kv.json`: TanStack keeps no `undefined`. */
	readonly get: QueryFactory<[], KvReading<TValues> | null, KvReadError>;
	readonly set: MutationFactory<
		{
			readonly [TKey in keyof TValues & string]: {
				readonly key: TKey;
				readonly value: TValues[TKey] | undefined;
			};
		}[keyof TValues & string],
		KvReading<TValues>,
		KvWriteError
	>;
};

export type FilesOptions = {
	readonly list: QueryFactory<[], FileListing, FileError>;
	readonly read: QueryFactory<[path: string], CapturedFile, FileError>;
	/**
	 * Write `content` at `path`: saved over `base`, the version the edit
	 * started from, merging with any change made since (`files.save`), or
	 * created as a new file that refuses an occupied path.
	 */
	readonly write: MutationFactory<
		{
			readonly path: string;
			readonly content: string | Uint8Array;
			readonly base?: ContentCapture;
		},
		SavedFile,
		FileSaveError
	>;
	readonly move: MutationFactory<
		{ readonly file: FileCapture; readonly to: string },
		FileCapture,
		FileError | MoveError
	>;
	readonly delete: MutationFactory<FileCapture, undefined, FileError>;
};

export type HistoryOptions = {
	readonly status: QueryFactory<[], FilesObservation, GitError>;
	readonly log: QueryFactory<[depth?: number], CommitSummary[], GitError>;
	/** Commit the folder's current files (`folder.git.commit`). */
	readonly saveVersion: MutationFactory<void, CommitOutcome, never>;
	readonly sync: MutationFactory<
		SyncOptions | undefined,
		SyncOutcome,
		SyncError
	>;
};

/** Names `folderOptions` uses itself; a table so named is under `tables` only. */
type Reserved = 'tables' | 'kv' | 'files' | 'history' | 'pathFilter' | 'key';

type TablesOptions<TDefinition extends FolderDefinition> = {
	readonly [K in keyof TDefinition['tables'] & string]: TableOptions<
		CreateRowOf<TDefinition['tables'][K]>
	>;
};

export type FolderOptions<TDefinition extends FolderDefinition> = Omit<
	TablesOptions<TDefinition>,
	Reserved
> & {
	/** Every table by name, including one named like a member below. */
	readonly tables: TablesOptions<TDefinition>;
	readonly kv: KvOptions<KvOf<TDefinition>>;
	readonly files: FilesOptions;
	readonly history: HistoryOptions;
	/** The prefix of every key this folder's queries cache under. */
	readonly key: readonly unknown[];
	/**
	 * The filter for the queries a change can have made stale: each row at
	 * a changed path, the listing of each table whose directory it reached,
	 * the settings for `kv.json`, the file listing and each changed file,
	 * and the history's status. A change inside `.git` (history moved) also
	 * makes the log stale. `'everything'` is every query of this folder.
	 */
	pathFilter(change: FilesChanged): InvalidateQueryFilters;
};

/** The key prefix for one opened folder: where its files are. */
function folderKey(folder: Pick<Folder<FolderDefinition>, 'location'>) {
	const { location } = folder;
	return [
		'folder',
		location.kind === 'opfs' ? location.directory : location.root,
	] as const;
}

/** An answer that is never an error, as a Result. */
const ok = <T>(value: T): Result<T, never> => Ok(value);

/** A read's `undefined` as `null`, which TanStack can cache. */
function orNull<T, E>(result: Result<T | undefined, E>): Result<T | null, E> {
	return result.error === null ? Ok(result.data ?? null) : Err(result.error);
}

/** Whether `path` is inside the folder's Git directory. */
const inGit = (path: string) => path === '.git' || path.startsWith('.git/');

export function folderOptions<TDefinition extends FolderDefinition>(
	folder: Folder<TDefinition, FolderDefinition>,
): FolderOptions<TDefinition> {
	const root = folderKey(folder);
	const keys = {
		table: (name: string) => [...root, 'tables', name] as const,
		list: (name: string) => [...root, 'tables', name, 'list'] as const,
		row: (name: string, stem: string) =>
			[...root, 'tables', name, 'row', stem] as const,
		kv: () => [...root, 'kv'] as const,
		files: () => [...root, 'files'] as const,
		fileList: () => [...root, 'files', 'list'] as const,
		file: (path: string) => [...root, 'files', 'read', path] as const,
		history: () => [...root, 'history'] as const,
		status: () => [...root, 'history', 'status'] as const,
		log: (depth: number) => [...root, 'history', 'log', depth] as const,
	};

	type Fields = Record<string, unknown>;

	function tableOptions(name: string): TableOptions<Fields> {
		const table = (folder.tables as Record<string, unknown>)[
			name
		] as FileTable<Fields>;
		/** Put `stored` in the row's query and the table's listing. */
		function cacheRow(client: QueryClient, stored: StoredRow<Fields>) {
			const stem = rowStemOf(name, stored.path);
			if (stem === undefined) return;
			client.setQueryData(keys.row(name, stem), stored);
			client.setQueryData<TableListing<Fields>>(keys.list(name), (listing) => {
				if (listing === undefined) return listing;
				const item = Object.freeze({ stem, result: Ok(stored) });
				return listing.some((entry) => entry.stem === stem)
					? listing.map((entry) => (entry.stem === stem ? item : entry))
					: [...listing, item];
			});
		}
		return {
			list: {
				queryKey: () => keys.list(name),
				queryOptions: () =>
					resultQueryOptions({
						queryKey: keys.list(name) as readonly unknown[],
						queryFn: () => table.list(),
					}),
			},
			get: {
				queryKey: (stem) => keys.row(name, stem),
				queryOptions: (stem) =>
					resultQueryOptions({
						queryKey: keys.row(name, stem) as readonly unknown[],
						queryFn: async () => orNull(await table.get(stem)),
					}),
			},
			create: {
				mutationOptions: () =>
					resultMutationOptions({
						mutationKey: [...keys.table(name), 'create'] as const,
						mutationFn: ({ row, stem }) =>
							table.create(row, stem === undefined ? undefined : { stem }),
						onSuccess: (stored, _variables, _result, { client }) =>
							cacheRow(client, stored),
					}),
			},
			save: {
				mutationOptions: () =>
					resultMutationOptions({
						mutationKey: [...keys.table(name), 'save'] as const,
						mutationFn: ({ base, row }) => table.save(base, row),
						onSuccess: (saved, _variables, _result, { client }) =>
							cacheRow(client, saved.stored),
					}),
			},
			rename: {
				mutationOptions: () =>
					resultMutationOptions({
						mutationKey: [...keys.table(name), 'rename'] as const,
						mutationFn: ({ file, stem }) => table.rename(file, stem),
						// The new capture holds no row: both stems and the listing
						// are read again.
						onSuccess: (_moved, { file, stem }, _result, { client }) => {
							const from = rowStemOf(name, file.path);
							return Promise.all([
								client.invalidateQueries({ queryKey: keys.list(name) }),
								client.invalidateQueries({ queryKey: keys.row(name, stem) }),
								from === undefined
									? undefined
									: client.invalidateQueries({
											queryKey: keys.row(name, from),
										}),
							]);
						},
					}),
			},
			delete: {
				mutationOptions: () =>
					resultMutationOptions({
						mutationKey: [...keys.table(name), 'delete'] as const,
						mutationFn: (file) => table.delete(file),
						onSuccess: (_done, file, _result, { client }) => {
							const stem = rowStemOf(name, file.path);
							if (stem === undefined) return;
							client.setQueryData<TableListing<Fields>>(
								keys.list(name),
								(listing) => listing?.filter((entry) => entry.stem !== stem),
							);
							return client.invalidateQueries({
								queryKey: keys.row(name, stem),
							});
						},
					}),
			},
		};
	}

	const tables: Record<string, TableOptions<Fields>> = {};
	for (const name of Object.keys(folder.tables))
		tables[name] = tableOptions(name);

	const settings = folder.kv as unknown as FileKv<Fields>;
	const kv: KvOptions<Fields> = {
		get: {
			queryKey: () => keys.kv(),
			queryOptions: () =>
				resultQueryOptions({
					queryKey: keys.kv() as readonly unknown[],
					queryFn: async () => orNull(await settings.get()),
				}),
		},
		set: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.kv(), 'set'] as const,
					mutationFn: ({ key, value }) => settings.set(key, value),
					onSuccess: (reading, _variables, _result, { client }) =>
						client.setQueryData(keys.kv(), reading),
				}),
		},
	};

	/** The listing and each named file are read again after a write. */
	const refreshFiles = (client: QueryClient, paths: readonly string[]) =>
		client.invalidateQueries({
			queryKey: keys.files(),
			predicate: (query) => {
				const [, , , kind, path] = query.queryKey;
				return (
					kind === 'list' || (kind === 'read' && paths.includes(path as string))
				);
			},
		});
	const files: FilesOptions = {
		list: {
			queryKey: () => keys.fileList(),
			queryOptions: () =>
				resultQueryOptions({
					queryKey: keys.fileList() as readonly unknown[],
					queryFn: () => folder.files.list(),
				}),
		},
		read: {
			queryKey: (path) => keys.file(path),
			queryOptions: (path) =>
				resultQueryOptions({
					queryKey: keys.file(path) as readonly unknown[],
					queryFn: () => folder.files.read(path),
				}),
		},
		write: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.files(), 'write'] as const,
					mutationFn: async ({ path, content, base }) => {
						if (base !== undefined) return folder.files.save(base, content);
						const { data: stored, error } = await folder.files.create(
							path,
							content,
						);
						if (error !== null) return Err(error);
						return Ok({ stored, merged: false, replaced: [] });
					},
					onSuccess: (saved, _variables, _result, { client }) =>
						refreshFiles(client, [saved.stored.path]),
				}),
		},
		move: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.files(), 'move'] as const,
					mutationFn: ({ file, to }) => folder.files.move(file, to),
					onSuccess: (moved, { file }, _result, { client }) =>
						refreshFiles(client, [file.path, moved.path]),
				}),
		},
		delete: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.files(), 'delete'] as const,
					mutationFn: (file) => folder.files.remove(file),
					onSuccess: (_done, file, _result, { client }) =>
						refreshFiles(client, [file.path]),
				}),
		},
	};

	/** A commit or a sync moved history: status and log are read again. */
	const refreshHistory = (client: QueryClient) =>
		client.invalidateQueries({ queryKey: keys.history() });
	const history: HistoryOptions = {
		status: {
			queryKey: () => keys.status(),
			queryOptions: () =>
				resultQueryOptions({
					queryKey: keys.status() as readonly unknown[],
					queryFn: () => folder.git.status(),
				}),
		},
		log: {
			queryKey: (depth = LOG_DEPTH) => keys.log(depth),
			queryOptions: (depth = LOG_DEPTH) =>
				resultQueryOptions({
					queryKey: keys.log(depth) as readonly unknown[],
					queryFn: () => folder.git.log(depth),
				}),
		},
		saveVersion: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.history(), 'saveVersion'] as const,
					// Every outcome is the commit's answer, `failed` included; the
					// app decides what a person is told.
					mutationFn: async () => ok(await folder.git.commit()),
					onSettled: (_outcome, _error, _variables, _result, { client }) =>
						refreshHistory(client),
				}),
		},
		sync: {
			mutationOptions: () =>
				resultMutationOptions({
					mutationKey: [...keys.history(), 'sync'] as const,
					// The files Sync wrote arrive on `onFilesChanged`.
					mutationFn: (options) => folder.sync.run(options),
					onSettled: (_outcome, _error, _variables, _result, { client }) =>
						refreshHistory(client),
				}),
		},
	};

	function pathFilter(change: FilesChanged): InvalidateQueryFilters {
		if (change === 'everything') return { queryKey: root };
		const paths = new Set(change);
		const historyMoved = change.some(inGit);
		const filesChanged = change.some((path) => !inGit(path));
		// A table's directory is the first segment of a path inside it.
		const tableDirectories = new Set(
			change.flatMap((path) => {
				const slash = path.indexOf('/');
				return slash === -1 || inGit(path) ? [] : [path.slice(0, slash)];
			}),
		);
		return {
			queryKey: root,
			predicate: (query: Query) => {
				const [, , area, ...rest] = query.queryKey;
				switch (area) {
					case 'tables': {
						const [name, kind, stem] = rest as [string, string, string?];
						if (kind === 'list') return tableDirectories.has(name);
						if (kind === 'row') return paths.has(rowPath(name, stem as string));
						return false;
					}
					case 'kv':
						return paths.has(KV_PATH);
					case 'files': {
						const [kind, path] = rest as [string, string?];
						if (kind === 'list') return filesChanged;
						return kind === 'read' && paths.has(path as string);
					}
					case 'history': {
						const [kind] = rest as [string];
						return kind === 'status' || historyMoved;
					}
					default:
						return false;
				}
			},
		};
	}

	return Object.freeze({
		...tables,
		tables: Object.freeze(tables),
		kv,
		files,
		history,
		key: root,
		pathFilter,
	}) as unknown as FolderOptions<TDefinition>;
}
