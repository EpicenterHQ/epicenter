/**
 * `@epicenter/folder/query`: an opened folder in a TanStack Query cache
 * (ADR-0548).
 *
 * `folderOptions(folder)` mirrors the folder's reads. Each exposes
 * `.queryOptions()` and `.queryKey()`, as tRPC's option factories do, so a
 * page composes them with TanStack itself:
 *
 * ```ts
 * const folder$ = folderOptions(folder);
 * createQuery(() => folder$.todos.list.queryOptions());
 * createQuery(() => folder$.files.text.queryOptions('notes/a.md'));
 * ```
 *
 * Reads go through the engine, which parses and validates each file. The
 * folder's channel is the one detector of outside changes, so every read is
 * fresh until it reports one: the options turn TanStack's own focus and
 * mount refetches off, and no read waits for a network. Changes the page did
 * not make arrive on `folder.onFilesChanged`, and the app root wires them,
 * once, to exactly the queries they name:
 *
 * ```ts
 * const stopChanges = folder$.invalidateOnChange(queryClient);
 * ```
 *
 * Invalidation reads again only the queries something observes; one no
 * view or observer holds is read when it is next asked for.
 *
 * `folderWrites(folder, client)` is the page's one way to write the folder:
 * the folder's write, its move, and each table's row helpers (ADR-0576),
 * each answering the engine's Result. Writes to one file run one at a time,
 * in the order they were made, whoever made them, so a `set` reads the file
 * the one before it wrote (`inTurn`). Each write keeps the cache in step
 * itself: it puts its result where it can (a row write sets its entry in the
 * listing, a file write the file's read and text), so the page that wrote
 * reads nothing back, and marks stale the rest of what a change to its paths
 * would, such as the history's status: the folder does not report a page's
 * own writes to it. A read still running when the write lands is read again
 * rather than kept. A failed write reads its paths again.
 *
 * Importing this module opens nothing.
 */
import {
	hashKey,
	type InvalidateQueryFilters,
	type Query,
	type QueryClient,
	type QueryObserverOptions,
} from '@tanstack/query-core';
import { Ok, type Result, unwrap } from 'wellcrafted/result';
import type { FileListing, FileRead } from './boundary.js';
import type { Definition } from './definition.js';
import type { FileError, RowWriteError, WriteError } from './errors.js';
import { type OpenedFile, openedFile, readTextFile } from './file-browser.js';
import type { FilesChanged, Folder, FolderAccess } from './folder.js';
import type { FilesObservation, GitError } from './git/history.js';
import type { FileContent } from './merge-file.js';
import { rowPath, rowStemOf } from './paths.js';
import type { Row } from './row-text.js';
import type { FileTable, TableListing, WrittenRow } from './table.js';
import type { Written } from './write.js';

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

export type TableOptions<TFields> = {
	readonly list: QueryFactory<[], TableListing<TFields>, FileError>;
};

export type FilesOptions = {
	readonly list: QueryFactory<[], FileListing, FileError>;
	readonly read: QueryFactory<[path: string], FileRead, FileError>;
	/**
	 * The file at `path` as an editor opens it (`openedFile`): its exact
	 * text, or its kind and size when it is binary or larger than 1 MiB.
	 */
	readonly text: QueryFactory<[path: string], OpenedFile, FileError>;
};

export type HistoryOptions = {
	readonly status: QueryFactory<[], FilesObservation, GitError>;
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
	 * The filter for the queries a change can have made stale: the listing
	 * of each table whose directory it reached, the file listing and each
	 * changed file, and the history's status. `'everything'` is every query
	 * of this folder.
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
export type FolderOptions<TDefinition extends Definition> = FolderOptionsOf<
	FolderAccess<TDefinition>['tables']
>;

/** What `folderOptions` reads of a folder: its tables typed by inference. */
type OptionsSource<TTables> = Pick<
	Folder<Definition>,
	'location' | 'files' | 'git' | 'onFilesChanged'
> & {
	readonly tables: TTables;
};

/** One table's writes: its row helpers, each in its file's turn. */
export type TableWrites<TFields> = {
	/** Write the change from one row to another into the row as it is now: what a body editor sends. */
	write(
		stem: string,
		from: Row<TFields> | null,
		to: Row<TFields> | null,
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/** Set fields of the row as it is now. */
	set(
		stem: string,
		fields: Partial<TFields>,
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/** Add a row at `stem`, or at a generated stem, which no write waits for. */
	create(
		row: Row<TFields>,
		options?: { readonly stem?: string },
	): Promise<Result<WrittenRow<TFields>, RowWriteError>>;
	/** Delete the row at `stem`, whatever it holds by then. */
	delete(stem: string): Promise<Result<undefined, WriteError>>;
};

/** Each of a folder's tables (`folder.tables`) as its writes. */
type TablesWrites<TTables> = {
	readonly [K in keyof TTables & string]: TTables[K] extends FileTable<
		infer TFields
	>
		? TableWrites<TFields>
		: never;
};

/**
 * The writes of an opened folder whose tables are `TTables`: what
 * `folderWrites(folder, client)` returns. Make one per opened folder: the
 * order of writes to one file is kept within it.
 */
export type FolderWritesOf<TTables> = {
	readonly tables: TablesWrites<TTables>;
	/**
	 * Write the change from `from` to `to` into the file at `path` as it is
	 * now (`folder.write`): a create from `null`, an edit, or a delete to
	 * `null`. Every cached query the path feeds is kept in step.
	 */
	write(
		path: string,
		from: FileContent | null,
		to: FileContent | null,
	): Promise<Result<Written, WriteError>>;
	/** Move the file at `path` to `next`, as it is (`folder.move`), once the writes to `path` made before it settled. */
	move(path: string, next: string): Promise<Result<Written, WriteError>>;
	/**
	 * Run `work` as a write to `path`: once every write to `path` made
	 * before it settled, and before any made after it starts. It is counted
	 * by `pending` until it settles. The cache is `work`'s to keep.
	 */
	inTurn<T>(path: string, work: () => Promise<T>): Promise<T>;
	/** How many writes to `path`, or to any file, run or wait now. */
	pending(path?: string): number;
	/** Hear each change of `pending`. */
	subscribe(listener: () => void): () => void;
	/**
	 * Resolves once no write to `path`, or to any file, runs or waits. A
	 * write made meanwhile is waited for too, and so is one made in the
	 * task right after the last settled, as an editor's next save is.
	 */
	idle(path?: string): Promise<void>;
};

/** The writes of a folder opened with `TDefinition`. */
export type FolderWrites<TDefinition extends Definition> = FolderWritesOf<
	FolderAccess<TDefinition>['tables']
>;

/** What `folderWrites` reads of a folder: its tables typed by inference. */
type WritesSource<TTables> = Pick<
	Folder<Definition>,
	'location' | 'write' | 'move'
> & {
	readonly tables: TTables;
};

/** The key prefix for one opened folder: where its files are. */
function folderKey(folder: Pick<Folder<Definition>, 'location'>) {
	const { location } = folder;
	return [
		'folder',
		location.kind === 'opfs' ? location.directory : location.root,
	] as const;
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

/** One folder's keys, and which of its queries a change reaches. */
function folderCache(folder: Pick<Folder<Definition>, 'location'>) {
	const root = folderKey(folder);
	const keys = {
		list: (name: string) => [...root, 'tables', name, 'list'] as const,
		fileList: () => [...root, 'files', 'list'] as const,
		file: (path: string) => [...root, 'files', 'read', path] as const,
		text: (path: string) => [...root, 'files', 'text', path] as const,
		status: () => [...root, 'history', 'status'] as const,
		query: (paths: readonly string[], key: readonly unknown[]) =>
			[...root, 'query', paths, ...key] as const,
	};

	/** Whether `query` holds what a change to `change` can have made stale. */
	function matches(change: readonly string[]) {
		const filesChanged = change.some((path) => !inGit(path));
		const paths = new Set(change);
		// A table's listing changes with one of its rows (the one row
		// predicate, `rowStemOf`), or with its directory itself.
		const tableDirectories = new Set(
			change.flatMap((path) => {
				if (inGit(path)) return [];
				const slash = path.indexOf('/');
				if (slash === -1) return [path];
				const table = path.slice(0, slash);
				return rowStemOf(table, path) === undefined ? [] : [table];
			}),
		);
		return (query: Query) => {
			const [, , area, ...rest] = query.queryKey;
			switch (area) {
				case 'tables': {
					const [name] = rest as [string];
					return tableDirectories.has(name);
				}
				case 'files': {
					const [kind, path] = rest as [string, string?];
					if (kind === 'list') return filesChanged;
					return paths.has(path as string);
				}
				// Any change, in a file or in history, is what status reads.
				case 'history':
					return true;
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

	return { root, keys, matches, pathFilter };
}

export function folderOptions<TTables>(
	folder: OptionsSource<TTables>,
): FolderOptionsOf<TTables> {
	const { root, keys, pathFilter } = folderCache(folder);

	const tables: Record<string, TableOptions<unknown>> = {};
	for (const name of Object.keys(folder.tables as object)) {
		const table = (folder.tables as Record<string, unknown>)[
			name
		] as FileTable<unknown>;
		tables[name] = {
			list: {
				queryKey: () => keys.list(name),
				queryOptions: () => readOptions(keys.list(name), () => table.list()),
			},
		};
	}

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
	};

	const history: HistoryOptions = {
		status: {
			queryKey: () => keys.status(),
			queryOptions: () => readOptions(keys.status(), () => folder.git.status()),
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

/** Where a create at a generated stem is counted: no other write names its path. */
const UNPLACED = Symbol('unplaced');

export function folderWrites<TTables>(
	folder: WritesSource<TTables>,
	client: QueryClient,
): FolderWritesOf<TTables> {
	const { root, keys, matches, pathFilter } = folderCache(folder);

	/** Each file's last write, by path: the next write to it starts once it settled. */
	const turns = new Map<string, Promise<void>>();
	/** How many writes run or wait, by path. */
	const counts = new Map<string | typeof UNPLACED, number>();
	let total = 0;
	const listeners = new Set<() => void>();

	function count(path: string | typeof UNPLACED, by: 1 | -1) {
		const next = (counts.get(path) ?? 0) + by;
		if (next === 0) counts.delete(path);
		else counts.set(path, next);
		total += by;
		for (const listener of [...listeners]) listener();
	}

	/** Run `work`, counted under `path` until it settles. */
	async function counted<T>(
		path: string | typeof UNPLACED,
		work: () => Promise<T>,
	): Promise<T> {
		count(path, 1);
		try {
			return await work();
		} finally {
			count(path, -1);
		}
	}

	function inTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
		const before = turns.get(path) ?? Promise.resolve();
		const mine = counted(path, () => before.then(work));
		const done = mine.then(
			() => {},
			() => {},
		);
		turns.set(path, done);
		void done.then(() => {
			if (turns.get(path) === done) turns.delete(path);
		});
		return mine;
	}

	function pending(path?: string) {
		return path === undefined ? total : (counts.get(path) ?? 0);
	}

	/**
	 * The page's own write landed at `paths`. The folder does not report it
	 * to the page, so what a change there makes stale is marked here, except
	 * `set`, the queries the write put its result in.
	 */
	function ownWrite(
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

	/** A write failed: the file is not what the base said, or the reply was lost, so its paths are read again. */
	function failed(paths: readonly string[]) {
		void client.invalidateQueries(pathFilter(paths));
	}

	/**
	 * Put a write's result in the query at `key`. A read of it still running
	 * may have read the file before the write, or after a later change, so
	 * it is stopped and done again, and the result is put meanwhile: stopping
	 * a read puts back what the query held before it, which an editor would
	 * show as the text typed before the save.
	 */
	async function put<T>(
		key: readonly unknown[],
		update: (current: T | undefined) => T | undefined,
	) {
		const filters = { queryKey: key, exact: true };
		if (client.isFetching(filters) === 0) {
			client.setQueryData<T>(key, update);
			return;
		}
		await client.cancelQueries(filters);
		client.setQueryData<T>(key, update);
		void client.invalidateQueries(filters);
	}

	type Fields = Record<string, unknown>;

	function tableWrites(name: string): TableWrites<Fields> {
		const table = (folder.tables as Record<string, unknown>)[
			name
		] as FileTable<Fields>;
		const pathOf = (stem: string) => rowPath(name, stem);

		/**
		 * The page wrote the row at `stem`: its entry in the listing is what
		 * the write left. A file left that is not a row is read again.
		 */
		async function wroteRow(stem: string, written: WrittenRow<Fields>) {
			const path = pathOf(stem);
			// No row stands there, or the file does not read as one: read again.
			if (written === null || !('row' in written)) return ownWrite([path]);
			const item = Object.freeze({ stem, result: Ok(written) });
			await put<TableListing<Fields>>(keys.list(name), (listing) =>
				listing?.some((entry) => entry.stem === stem)
					? listing.map((entry) => (entry.stem === stem ? item : entry))
					: listing && [...listing, item],
			);
			ownWrite([path], [keys.list(name)]);
		}

		/** The page deleted the row at `stem`: the listing lacks it. */
		async function deletedRow(stem: string) {
			await put<TableListing<Fields>>(keys.list(name), (listing) =>
				listing?.filter((entry) => entry.stem !== stem),
			);
			ownWrite([pathOf(stem)], [keys.list(name)]);
		}

		/** Run a row write in its file's turn; a failure reads the file again. */
		const rowWrite = <TData, TError>(
			stem: string,
			run: () => Promise<Result<TData, TError>>,
			wrote: (data: TData) => Promise<void>,
		) =>
			inTurn(pathOf(stem), async () => {
				const result = await run();
				if (result.error !== null) failed([pathOf(stem)]);
				else await wrote(result.data as TData);
				return result;
			});

		return {
			write: (stem, from, to) =>
				rowWrite(
					stem,
					() => table.write(stem, from, to),
					(written) =>
						to === null ? deletedRow(stem) : wroteRow(stem, written),
				),
			set: (stem, fields) =>
				rowWrite(
					stem,
					() => table.set(stem, fields),
					(written) => wroteRow(stem, written),
				),
			create(row, options) {
				const stem = options?.stem;
				if (stem !== undefined)
					return rowWrite(
						stem,
						() => table.create(row, { stem }),
						(written) => wroteRow(stem, written),
					);
				return counted(UNPLACED, async () => {
					const result = await table.create(row);
					if (result.error !== null) return result;
					const written = result.data;
					const at =
						written === null ? undefined : rowStemOf(name, written.path);
					if (at !== undefined) await wroteRow(at, written);
					// A generated stem whose file is not a row: the listing says.
					else void client.invalidateQueries({ queryKey: keys.list(name) });
					return result;
				});
			},
			delete: (stem) =>
				rowWrite(
					stem,
					() => table.delete(stem),
					() => deletedRow(stem),
				),
		};
	}

	const tables: Record<string, TableWrites<Fields>> = {};
	for (const name of Object.keys(folder.tables as object))
		tables[name] = tableWrites(name);

	return Object.freeze({
		tables: Object.freeze(tables),
		write: (path: string, from: FileContent | null, to: FileContent | null) =>
			inTurn(path, async () => {
				const result = await folder.write(path, from, to);
				if (result.error !== null) {
					failed([path]);
					return result;
				}
				const { file } = result.data;
				// The file read and opened, where a view holds them, is what the
				// write left; what else the path feeds is read again.
				if (file === null) {
					ownWrite([path]);
					return result;
				}
				await Promise.all([
					put<FileRead>(keys.file(path), (held) => held && file),
					put<OpenedFile>(keys.text(path), (held) =>
						held === undefined ? undefined : openedFile(file.bytes),
					),
				]);
				ownWrite([path], [keys.file(path), keys.text(path)]);
				return result;
			}),
		move: (path: string, next: string) =>
			inTurn(path, async () => {
				const result = await folder.move(path, next);
				if (result.error !== null) failed([path, next]);
				else ownWrite([path, next]);
				return result;
			}),
		inTurn,
		pending,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		idle: (path?: string) =>
			new Promise<void>((resolve) => {
				const idle = () => pending(path) === 0;
				function check() {
					if (!idle()) return;
					setTimeout(() => {
						if (!idle() || !listeners.has(check)) return;
						listeners.delete(check);
						resolve();
					});
				}
				listeners.add(check);
				check();
			}),
	}) as unknown as FolderWritesOf<TTables>;
}
