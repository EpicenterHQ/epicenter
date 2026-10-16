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
 * createMutation(() => folder$.todos.set.mutationOptions());
 * ```
 *
 * Each row helper of the folder's one write (ADR-0576) is its own mutation,
 * so each control owns its pending and error state. Writes to one file run
 * one at a time, in the order they were made, whichever control or mutation
 * made them, so a `set` reads the file the one before it wrote. The folder's options keep that order
 * themselves rather than in a TanStack mutation scope: a scoped mutation
 * waiting its turn resumes only while the window has focus, and a save must
 * not wait for the person to come back.
 *
 * Reads go through the engine, which parses and validates each file. A
 * write keeps the cache in step itself, inside its `mutationFn`, so a
 * caller's own callbacks add to it. It puts its result where it can (a save
 * sets its row and the listing, a file write the file's read and text), so
 * the page that wrote reads nothing back, and marks stale the rest of what
 * a change to its paths would, such as the history's status: the folder
 * does not report a page's own writes to it. A read still running when the
 * write lands is read again rather than kept. A failed write reads its
 * paths again. Changes the page did not make arrive on
 * `folder.onFilesChanged`, and the app root wires them, once, to exactly
 * the queries they name:
 *
 * ```ts
 * const stopChanges = folder$.invalidateOnChange(queryClient);
 * ```
 *
 * The folder's channel is the one detector of outside changes, so every read
 * is fresh until it reports one: the options turn TanStack's own focus and
 * mount refetches off, and neither reads nor writes wait for a network.
 *
 * Invalidation reads again only the queries something observes; one no
 * view or observer holds is read when it is next asked for. A store that
 * reads with `getQueryData` observes what it shows.
 *
 * Nothing here holds the query client: a write reaches the cache through
 * the client TanStack hands its `mutationFn`. `runMutation` runs a write
 * from outside a component and `whenIdle` waits for writes to settle.
 * Importing this module opens nothing.
 */
import {
	hashKey,
	type InvalidateQueryFilters,
	type MutationFilters,
	type MutationObserverOptions,
	type MutationOptions,
	type Query,
	type QueryClient,
	type QueryObserverOptions,
} from '@tanstack/query-core';
import { Err, isErr, Ok, type Result, unwrap } from 'wellcrafted/result';
import type { FileListing } from './boundary.js';
import type { CapturedFile, ContentCapture, FileCapture } from './capture.js';
import type { FolderDefinition } from './definition.js';
import type {
	FileError,
	FileSaveError,
	MoveError,
	RowReadError,
	TableEnumerationError,
	WriteError,
} from './errors.js';
import { type OpenedFile, openedFile, readTextFile } from './file-browser.js';
import type { FilesChanged, Folder, FolderAccess } from './folder.js';
import type { SyncError } from './git/errors.js';
import type {
	CommitOutcome,
	FilesObservation,
	GitError,
} from './git/history.js';
import type { CommitSummary } from './git/objects.js';
import type { SyncOptions, SyncOutcome } from './git/sync.js';
import { rowPath, rowStemOf } from './paths.js';
import type { Row } from './row-text.js';
import type { SavedFile } from './save-file.js';
import type {
	FileTable,
	StoredRow,
	TableListing,
	WrittenRow,
} from './table.js';

export {
	createTextDraft,
	type SaveTextVariables,
	type SentText,
	type TextDraft,
	type WrittenText,
	writtenFile,
} from './draft.js';

/** How many commits `history.log` reads when the caller names no depth. */
const LOG_DEPTH = 50;

/**
 * How every read is cached. A read is local, so it waits for no network,
 * and a file that did not read will not read on a retry, or because a view
 * mounted: the failure is shown. Nothing goes stale
 * on its own or on focus: a query is read again only when a change the
 * folder reports, or the page's own write, makes it stale.
 */
const READ = {
	networkMode: 'always',
	retry: false,
	retryOnMount: false,
	staleTime: Number.POSITIVE_INFINITY,
	refetchOnWindowFocus: false,
} as const;

/** A read: TanStack options for `createQuery`, and the key they cache under. */
type QueryFactory<TArgs extends unknown[], TData, TError> = {
	queryOptions(
		...args: TArgs
	): QueryObserverOptions<TData, TError, TData, TData, readonly unknown[]>;
	queryKey(...args: TArgs): readonly unknown[];
};

/**
 * A write: TanStack options for `createMutation`. The write keeps the cache
 * in step inside its own `mutationFn`, so a caller's `onSuccess`,
 * `onError`, or `onSettled` adds to it and replaces nothing.
 */
type MutationFactory<TVariables, TData, TError> = {
	mutationOptions(): MutationObserverOptions<TData, TError, TVariables>;
};

/** What a row write sends: the row's stem, and the change from `from` to `to` (`table.write`). */
export type WriteRowVariables<TFields> = {
	readonly stem: string;
	readonly from: Row<TFields> | null;
	readonly to: Row<TFields> | null;
};

/** What a field set sends: the row's stem, and the fields to set (`table.set`). */
export type SetRowVariables<TFields> = {
	readonly stem: string;
	readonly fields: Partial<TFields>;
};

export type TableOptions<TFields> = {
	readonly list: QueryFactory<[], TableListing<TFields>, TableEnumerationError>;
	/** `null` when no file is at the stem: TanStack keeps no `undefined`. */
	readonly get: QueryFactory<
		[stem: string],
		StoredRow<TFields> | null,
		RowReadError
	>;
	/** Write the change from one row to another into the row as it is now: what a body editor sends. */
	readonly write: MutationFactory<
		WriteRowVariables<TFields>,
		WrittenRow<TFields>,
		WriteError
	>;
	/** Set fields of the row as it is now. */
	readonly set: MutationFactory<
		SetRowVariables<TFields>,
		WrittenRow<TFields>,
		WriteError
	>;
	readonly create: MutationFactory<
		{ readonly row: Row<TFields>; readonly stem?: string },
		WrittenRow<TFields>,
		WriteError
	>;
	/** Delete the row at the stem it is sent. */
	readonly delete: MutationFactory<string, undefined, WriteError>;
};

export type FilesOptions = {
	readonly list: QueryFactory<[], FileListing, FileError>;
	readonly read: QueryFactory<[path: string], CapturedFile, FileError>;
	/**
	 * The file at `path` as an editor opens it (`openedFile`): its exact
	 * text, or its kind and size when it is binary or larger than 1 MiB.
	 */
	readonly text: QueryFactory<[path: string], OpenedFile, FileError>;
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
type Reserved =
	| 'tables'
	| 'files'
	| 'history'
	| 'pathFilter'
	| 'invalidateOnChange'
	| 'key'
	| 'query';

/** Each of a folder's tables (`folder.tables`) as its options. */
type TablesOptions<TTables> = {
	readonly [K in keyof TTables & string]: TTables[K] extends FileTable<
		infer TFields
	>
		? TableOptions<TFields>
		: never;
};

/**
 * The options of an opened folder whose tables are `TTables`: what
 * `folderOptions(folder)` returns.
 */
export type FolderOptionsOf<TTables> = Omit<
	TablesOptions<TTables>,
	Reserved
> & {
	/** Every table by name, including one named like a member below. */
	readonly tables: TablesOptions<TTables>;
	readonly files: FilesOptions;
	readonly history: HistoryOptions;
	/** The prefix of every key this folder's queries cache under. */
	readonly key: readonly unknown[];
	/**
	 * The filter for the queries a change can have made stale: each row at
	 * a changed path, the listing of each table whose directory it reached,
	 * the file listing and each changed file,
	 * and the history's status. A change inside `.git` (history moved) also
	 * makes the log stale. `'everything'` is every query of this folder.
	 */
	pathFilter(change: FilesChanged): InvalidateQueryFilters;
	/**
	 * Invalidate `client`'s queries of this folder whenever the folder reports
	 * changed files (`folder.onFilesChanged`), each change through `pathFilter`.
	 * Call it before anything reads, so no change falls between; the returned
	 * function stops it, on close or when the page opens another folder.
	 */
	invalidateOnChange(client: QueryClient): () => void;
	/**
	 * A query of the page's own over the files at `paths`, each a file or a
	 * directory: cached as every read here is, under `key` within this
	 * folder, and stale whenever a change reaches one of `paths`.
	 */
	query<TData, TError>(input: {
		readonly paths: readonly string[];
		readonly key: readonly unknown[];
		readonly queryFn: () => Promise<Result<TData, TError>>;
	}): QueryObserverOptions<TData, TError, TData, TData, readonly unknown[]>;
};

/** The options of a folder opened with `TDefinition`. */
export type FolderOptions<TDefinition extends FolderDefinition> =
	FolderOptionsOf<FolderAccess<TDefinition>['tables']>;

/** What `folderOptions` reads of a folder: its tables typed by inference. */
type OptionsSource<TTables> = Pick<
	Folder<FolderDefinition>,
	'location' | 'files' | 'git' | 'sync' | 'onFilesChanged'
> & {
	readonly tables: TTables;
};

/**
 * Run a write's options once from outside a component, as a component's
 * `mutateAsync` does: through `client`'s mutation cache, so `isMutating`
 * and `whenIdle` count it, resolving with what it wrote or rejecting with
 * its error.
 */
export function runMutation<TData, TError, TVariables>(
	client: QueryClient,
	options: MutationOptions<TData, TError, TVariables>,
	variables: TVariables,
): Promise<TData> {
	return client.getMutationCache().build(client, options).execute(variables);
}

/**
 * Resolves once nothing matching `filters` is mutating, watching the
 * mutation cache, so a write that starts meanwhile is waited for too. A
 * draft sends its next save just after the last one settles, so idle counts
 * only once the tasks queued meanwhile have run.
 */
export function whenIdle(
	client: QueryClient,
	filters?: MutationFilters,
): Promise<void> {
	return new Promise((resolve) => {
		const idle = () => client.isMutating(filters) === 0;
		const unsubscribe = client.getMutationCache().subscribe(check);
		function check() {
			if (!idle()) return;
			setTimeout(() => {
				if (!idle()) return;
				unsubscribe();
				resolve();
			});
		}
		check();
	});
}

/**
 * Each opened folder's last write to each file, by path: a write to a file
 * starts once the one before it settled, landed or not, whichever options
 * object made it.
 */
const turns = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Run `write` to `path` of `folder` once the writes to it made before have settled. */
function inTurn<T>(
	folder: object,
	path: string,
	write: () => Promise<T>,
): Promise<T> {
	let files = turns.get(folder);
	if (files === undefined) {
		files = new Map();
		turns.set(folder, files);
	}
	const mine = (files.get(path) ?? Promise.resolve()).then(write, write);
	const done = mine.then(
		() => {},
		() => {},
	);
	files.set(path, done);
	void done.then(() => {
		if (files.get(path) === done) files.delete(path);
	});
	return mine;
}

/** The key prefix for one opened folder: where its files are. */
function folderKey(folder: Pick<Folder<FolderDefinition>, 'location'>) {
	const { location } = folder;
	return [
		'folder',
		location.kind === 'opfs' ? location.directory : location.root,
	] as const;
}

/** A read's `undefined` as `null`, which TanStack can cache. */
function orNull<T, E>(result: Result<T | undefined, E>): Result<T | null, E> {
	return result.error === null ? Ok(result.data ?? null) : Err(result.error);
}

/** Whether `path` is inside the folder's Git directory. */
const inGit = (path: string) => path === '.git' || path.startsWith('.git/');

/** Whether `path` is `within`, or a file under the directory `within`. */
const reaches = (path: string, within: string) =>
	path === within || path.startsWith(`${within}/`);

/** Read options for `queryKey`, unwrapping `queryFn`'s Result. */
function readOptions<TData, TError>(
	queryKey: readonly unknown[],
	queryFn: () => Promise<Result<TData, TError>>,
): QueryObserverOptions<TData, TError, TData, TData, readonly unknown[]> {
	return {
		...READ,
		queryKey,
		queryFn: async () => unwrap(await queryFn()),
	};
}

export function folderOptions<TTables>(
	folder: OptionsSource<TTables>,
): FolderOptionsOf<TTables> {
	const root = folderKey(folder);
	const keys = {
		table: (name: string) => [...root, 'tables', name] as const,
		list: (name: string) => [...root, 'tables', name, 'list'] as const,
		row: (name: string, stem: string) =>
			[...root, 'tables', name, 'row', stem] as const,
		files: () => [...root, 'files'] as const,
		fileList: () => [...root, 'files', 'list'] as const,
		file: (path: string) => [...root, 'files', 'read', path] as const,
		text: (path: string) => [...root, 'files', 'text', path] as const,
		history: () => [...root, 'history'] as const,
		status: () => [...root, 'history', 'status'] as const,
		log: (depth: number) => [...root, 'history', 'log', depth] as const,
		query: (paths: readonly string[], key: readonly unknown[]) =>
			[...root, 'query', paths, ...key] as const,
	};

	/** Whether `query` holds what a change to `change` can have made stale. */
	function matches(change: readonly string[]) {
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
		return (query: Query) => {
			const [, , area, ...rest] = query.queryKey;
			switch (area) {
				case 'tables': {
					const [name, kind, stem] = rest as [string, string, string?];
					if (kind === 'list') return tableDirectories.has(name);
					if (kind === 'row') return paths.has(rowPath(name, stem as string));
					return false;
				}
				case 'files': {
					const [kind, path] = rest as [string, string?];
					if (kind === 'list') return filesChanged;
					return (
						(kind === 'read' || kind === 'text') && paths.has(path as string)
					);
				}
				case 'history': {
					const [kind] = rest as [string];
					return kind === 'status' || historyMoved;
				}
				case 'query': {
					const [within] = rest as [readonly string[]];
					return change.some((path) =>
						within.some((dir) => reaches(path, dir)),
					);
				}
				default:
					return false;
			}
		};
	}

	function pathFilter(change: FilesChanged): InvalidateQueryFilters {
		if (change === 'everything') return { queryKey: root };
		return { queryKey: root, predicate: matches(change) };
	}

	/**
	 * The page's own write landed at `paths`. The folder does not report it
	 * to the page, so what a change there makes stale is marked here, except
	 * `set`, the queries the write put its result in.
	 */
	function ownWrite(
		client: QueryClient,
		paths: readonly string[],
		set: readonly (readonly unknown[])[] = [],
	) {
		const reached = matches(paths);
		const kept = new Set(set.map((key) => hashKey(key)));
		void client.invalidateQueries({
			queryKey: root,
			predicate: (query) => !kept.has(query.queryHash) && reached(query),
		});
	}

	/**
	 * Put a write's result in the query at `key`. A read of it still running
	 * may have read the file before the write, or after a later change, so
	 * it is stopped and done again instead.
	 */
	async function put<T>(
		client: QueryClient,
		key: readonly unknown[],
		update: (current: T | undefined) => T | undefined,
	) {
		const filters = { queryKey: key, exact: true };
		if (client.isFetching(filters) === 0) {
			client.setQueryData<T>(key, update);
			return;
		}
		await client.cancelQueries(filters);
		void client.invalidateQueries(filters);
	}

	/**
	 * Write options. `run` writes; `wrote` keeps the cache in step with what
	 * it wrote, and `touched` names the paths a failure leaves the cache unsure
	 * of, which are read again: the file is not what the base said, or the
	 * reply was lost.
	 */
	function writeOptions<TVariables, TData, TError>({
		mutationKey,
		file,
		run,
		wrote,
		touched,
	}: {
		mutationKey: readonly unknown[];
		/** The file the write is to; writes to one file run one at a time, in order. */
		file?: (variables: TVariables) => string | undefined;
		run: (variables: TVariables) => Promise<Result<TData, TError>>;
		wrote: (client: QueryClient, data: TData, variables: TVariables) => unknown;
		touched: (variables: TVariables) => readonly string[];
	}): MutationObserverOptions<TData, TError, TVariables> {
		async function write(variables: TVariables, client: QueryClient) {
			const result = await run(variables);
			if (isErr(result)) {
				const paths = touched(variables);
				if (paths.length > 0) void client.invalidateQueries(pathFilter(paths));
				throw result.error;
			}
			await wrote(client, result.data, variables);
			return result.data;
		}
		return {
			mutationKey,
			networkMode: 'always',
			mutationFn: (variables, { client }) => {
				const path = file?.(variables);
				return path === undefined
					? write(variables, client)
					: inTurn(folder, path, () => write(variables, client));
			},
		};
	}

	type Fields = Record<string, unknown>;

	function tableOptions(name: string): TableOptions<Fields> {
		const table = (folder.tables as Record<string, unknown>)[
			name
		] as FileTable<Fields>;
		/**
		 * The page wrote the row at `stem`: its row and its entry in the
		 * listing are what the write left. A file left that is not a row is
		 * read again.
		 */
		async function wroteRow(
			client: QueryClient,
			stem: string,
			written: WrittenRow<Fields>,
		) {
			const path = rowPath(name, stem);
			// No row stands there, or the file does not read as one: read again.
			if (written === null || !('row' in written))
				return ownWrite(client, [path]);
			const item = Object.freeze({ stem, result: Ok(written) });
			await Promise.all([
				put(client, keys.row(name, stem), () => written),
				put<TableListing<Fields>>(client, keys.list(name), (listing) =>
					listing?.some((entry) => entry.stem === stem)
						? listing.map((entry) => (entry.stem === stem ? item : entry))
						: listing && [...listing, item],
				),
			]);
			ownWrite(client, [path], [keys.row(name, stem), keys.list(name)]);
		}
		/** The page deleted the row at `stem`: its row is none, and the listing lacks it. */
		async function deletedRow(client: QueryClient, stem: string) {
			await Promise.all([
				put(client, keys.row(name, stem), () => null),
				put<TableListing<Fields>>(client, keys.list(name), (listing) =>
					listing?.filter((entry) => entry.stem !== stem),
				),
			]);
			ownWrite(
				client,
				[rowPath(name, stem)],
				[keys.row(name, stem), keys.list(name)],
			);
		}
		return {
			list: {
				queryKey: () => keys.list(name),
				queryOptions: () => readOptions(keys.list(name), () => table.list()),
			},
			get: {
				queryKey: (stem) => keys.row(name, stem),
				queryOptions: (stem) =>
					readOptions(keys.row(name, stem), async () =>
						orNull(await table.get(stem)),
					),
			},
			write: {
				mutationOptions: () =>
					writeOptions({
						mutationKey: [...keys.table(name), 'write'],
						file: ({ stem }: WriteRowVariables<Fields>) => rowPath(name, stem),
						run: ({ stem, from, to }: WriteRowVariables<Fields>) =>
							table.write(stem, from, to),
						wrote: (client, row, { stem, to }) =>
							to === null
								? deletedRow(client, stem)
								: wroteRow(client, stem, row),
						touched: ({ stem }) => [rowPath(name, stem)],
					}),
			},
			set: {
				mutationOptions: () =>
					writeOptions({
						mutationKey: [...keys.table(name), 'set'],
						file: ({ stem }: SetRowVariables<Fields>) => rowPath(name, stem),
						run: ({ stem, fields }: SetRowVariables<Fields>) =>
							table.set(stem, fields),
						wrote: (client, row, { stem }) => wroteRow(client, stem, row),
						touched: ({ stem }) => [rowPath(name, stem)],
					}),
			},
			create: {
				mutationOptions: () =>
					writeOptions({
						mutationKey: [...keys.table(name), 'create'],
						file: ({ stem }: { row: Row<Fields>; stem?: string }) =>
							stem === undefined ? undefined : rowPath(name, stem),
						run: ({ row, stem }: { row: Row<Fields>; stem?: string }) =>
							table.create(row, stem === undefined ? undefined : { stem }),
						wrote: (client, row, { stem }) => {
							const at =
								stem ?? (row === null ? undefined : rowStemOf(name, row.path));
							if (at !== undefined) return wroteRow(client, at, row);
							// A generated stem whose file is not a row: the listing says.
							return client.invalidateQueries({ queryKey: keys.list(name) });
						},
						touched: ({ stem }) =>
							stem === undefined ? [] : [rowPath(name, stem)],
					}),
			},
			delete: {
				mutationOptions: () =>
					writeOptions({
						mutationKey: [...keys.table(name), 'delete'],
						file: (stem: string) => rowPath(name, stem),
						run: (stem: string) => table.delete(stem),
						wrote: (client, _done, stem) => deletedRow(client, stem),
						touched: (stem) => [rowPath(name, stem)],
					}),
			},
		};
	}

	const tables: Record<string, TableOptions<Fields>> = {};
	for (const name of Object.keys(folder.tables as object))
		tables[name] = tableOptions(name);

	const files: FilesOptions = {
		list: {
			queryKey: () => keys.fileList(),
			queryOptions: () =>
				readOptions(keys.fileList(), () => folder.files.list()),
		},
		read: {
			queryKey: (path) => keys.file(path),
			queryOptions: (path) =>
				readOptions(keys.file(path), () => folder.files.read(path)),
		},
		text: {
			queryKey: (path) => keys.text(path),
			queryOptions: (path) =>
				readOptions(keys.text(path), () => readTextFile(folder.files, path)),
		},
		write: {
			mutationOptions: () =>
				writeOptions({
					mutationKey: [...keys.files(), 'write'],
					run: async ({
						path,
						content,
						base,
					}: {
						path: string;
						content: string | Uint8Array;
						base?: ContentCapture;
					}): Promise<Result<SavedFile, FileSaveError>> => {
						if (base !== undefined) return folder.files.save(base, content);
						const { data: stored, error } = await folder.files.create(
							path,
							content,
						);
						if (error !== null) return Err(error);
						return Ok({ stored, merged: false });
					},
					// The file read and opened, where a view holds them, is what the
					// write wrote.
					wrote: async (client, { stored }) => {
						const { path } = stored;
						await Promise.all([
							put(client, keys.file(path), (held) => held && stored),
							put(client, keys.text(path), (held) =>
								held === undefined ? undefined : openedFile(stored),
							),
						]);
						ownWrite(client, [path], [keys.file(path), keys.text(path)]);
					},
					touched: ({ path }) => [path],
				}),
		},
		move: {
			mutationOptions: () =>
				writeOptions({
					mutationKey: [...keys.files(), 'move'],
					run: ({ file, to }: { file: FileCapture; to: string }) =>
						folder.files.move(file, to),
					wrote: (client, moved, { file }) =>
						ownWrite(client, [file.path, moved.path]),
					touched: ({ file, to }) => [file.path, to],
				}),
		},
		delete: {
			mutationOptions: () =>
				writeOptions({
					mutationKey: [...keys.files(), 'delete'],
					run: (file: FileCapture) => folder.files.remove(file),
					wrote: (client, _done, file) => ownWrite(client, [file.path]),
					touched: (file) => [file.path],
				}),
		},
	};

	/** A commit or a sync moved history, landed or not: status and log are read again. */
	const historyOptions = <TVariables, TData, TError>(
		name: string,
		run: (variables: TVariables) => Promise<Result<TData, TError>>,
	): MutationObserverOptions<TData, TError, TVariables> => ({
		mutationKey: [...keys.history(), name],
		networkMode: 'always',
		mutationFn: async (variables, { client }) => {
			const result = await run(variables);
			void client.invalidateQueries({ queryKey: keys.history() });
			return unwrap(result);
		},
	});
	const history: HistoryOptions = {
		status: {
			queryKey: () => keys.status(),
			queryOptions: () => readOptions(keys.status(), () => folder.git.status()),
		},
		log: {
			queryKey: (depth = LOG_DEPTH) => keys.log(depth),
			queryOptions: (depth = LOG_DEPTH) =>
				readOptions(keys.log(depth), () => folder.git.log(depth)),
		},
		saveVersion: {
			// Every outcome is the commit's answer, `failed` included; the app
			// decides what a person is told.
			mutationOptions: () =>
				historyOptions('saveVersion', async () =>
					Ok(await folder.git.commit()),
				),
		},
		sync: {
			// The files Sync wrote arrive on `onFilesChanged`.
			mutationOptions: () =>
				historyOptions('sync', (options: SyncOptions | undefined) =>
					folder.sync.run(options),
				),
		},
	};

	return Object.freeze({
		...tables,
		tables: Object.freeze(tables),
		files,
		history,
		key: root,
		pathFilter,
		invalidateOnChange: (client: QueryClient) =>
			folder.onFilesChanged((change) => {
				void client.invalidateQueries(pathFilter(change));
			}),
		query: <TData, TError>({
			paths,
			key,
			queryFn,
		}: {
			paths: readonly string[];
			key: readonly unknown[];
			queryFn: () => Promise<Result<TData, TError>>;
		}) => readOptions(keys.query(paths, key), queryFn),
	}) as unknown as FolderOptionsOf<TTables>;
}
