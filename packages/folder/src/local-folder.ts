/**
 * The browser's default local folder: `openFolder({ tables })`.
 *
 * One folder per web origin, kept in IndexedDB by the browser repository
 * engine (`./browser/`) and reopened under a fixed internal key. The key is independent of
 * any app name, account, or remote, and opening needs no authentication,
 * network, or schema file (ADR-0633, ADR-0636). The handle exposes rooted
 * `files`, table views that interpret Markdown rows through the caller's
 * schemas, change notification, local-save status, and `close`.
 *
 * A schema only interprets. A row that does not fit still comes back with its
 * exact source, its raw fields, and the issues, and a save never validates
 * against the schema, so unknown fields and repairable content survive
 * (ADR-0632). Each edit names the content it started from, and the engine
 * merges it with whatever else was saved meanwhile.
 *
 * This handle reads no data kept by the older OPFS folders. It opens the
 * IndexedDB store, which is empty on a fresh profile. Bringing existing
 * folders across is separate work.
 *
 * A call on a closed handle throws, as the engine's does: it is a programming
 * error, not a storage failure. Failures that storage reports come back as
 * `ReadError` and `SaveError` results; a failed save leaves earlier storage
 * unchanged.
 */
import type { TSchema as Schema } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';
import { legacyOpfsFolders } from './browser/legacy-data.js';
import {
	isTableName,
	openRepository,
	type ReadError,
	type SaveError,
} from './browser/repository.js';
import type { StorageChange } from './browser/storage.js';
import { OpenFolderError } from './errors.js';
import { callObserver } from './observer.js';
import type { FileContent } from './shared/merge.js';
import type { Issue, Row, RowChange } from './shared/row.js';

export type { ReadError, SaveError };
export type LocalRow<TSchema extends Schema = Schema> = Row<TSchema>;
export type LocalRowChange = RowChange;
export type LocalIssue = Issue;

/**
 * The fixed key of this origin's default local data. A web origin holds one
 * ordinary app (ADR-0636); separately isolated apps need separate origins.
 */
const DEFAULT_KEY = 'default';

/** A committed change to file contents, from this handle or from another. */
export type FolderChange = StorageChange;

/**
 * What the handle can truthfully say about saving. `'local'` is the normal
 * state of data without a sync destination, not a connection fault. A save
 * counts as saved only after IndexedDB committed it. `storageFailure` is the
 * last storage failure, cleared by a later successful save on this handle,
 * including a retry whose desired content is already stored. Individual
 * refusals and unsaved drafts belong to their callers.
 */
export type FolderStatus = {
	readonly state: 'local';
	/** Saves started on this handle and not yet committed or refused. */
	readonly saving: boolean;
	readonly storageFailure: Extract<SaveError, { name: 'StorageFailed' }> | null;
};

export type LocalFiles = {
	/** Paths under `prefix`, relative to the root, sorted. */
	list(prefix?: string): Promise<Result<string[], ReadError>>;
	/** The file at `path`, or `undefined` when none exists. */
	read(
		path: string,
	): Promise<Result<{ path: string; content: Blob } | undefined, ReadError>>;
	/**
	 * Save `content` at `path`. `from` is the content the edit started from, or
	 * `null` for a new file; it lets the engine keep other saves that landed
	 * meanwhile. Pass bytes for binary files or to retain a byte-order mark.
	 */
	write(
		path: string,
		from: FileContent | null,
		content: FileContent,
	): Promise<Result<void, SaveError>>;
	delete(
		path: string,
		from: FileContent | null,
	): Promise<Result<{ deleted: boolean }, SaveError>>;
};

export type LocalTable<TSchema extends Schema = Schema> = {
	/** Every row of the table, with its source, fields, and issues. */
	list(): Promise<Result<Row<TSchema>[], ReadError>>;
	get(id: string): Promise<Result<Row<TSchema> | undefined, ReadError>>;
	/**
	 * Save a change to row `id` starting from `from`, the row as read, or `null`
	 * for a new row. Returns `sent`, the row this save submitted, to start the
	 * next edit from. The schema never refuses a save.
	 */
	set(
		id: string,
		from: Row<TSchema> | null,
		change: RowChange,
	): Promise<Result<{ sent: Row<TSchema> }, SaveError>>;
	/** Delete the row and its attachment folder. */
	delete(
		id: string,
		from: Row<TSchema> | null,
	): Promise<Result<{ deleted: boolean }, SaveError>>;
	/** The files beside row `id`, in `<table>/<id>/`. */
	files(id: string): LocalFiles;
};

/**
 * The handle `openFolder({ tables })` returns.
 *
 * Subscribe before reading: a notification means a read may now differ, and
 * `change.paths` says where (`null` when unknown).
 */
export type Folder<TTables extends Record<string, Schema>> = {
	readonly files: LocalFiles;
	readonly tables: { [TName in keyof TTables]: LocalTable<TTables[TName]> };
	/**
	 * Called after a save commits, whether this handle or another one (another
	 * tab, or a second handle in this page) made it. The listener is not called
	 * for the current state. Returns the function that stops listening.
	 */
	onChange(listener: (change: FolderChange) => void): () => void;
	readonly status: FolderStatus;
	/** Called when `status` changes. Returns the function that stops listening. */
	onStatusChange(listener: (status: FolderStatus) => void): () => void;
	/**
	 * Close the handle. New calls throw at once; saves already started finish
	 * and report their real outcome; then listeners are released and the
	 * database connection closes. Saved work stays saved. Closing again
	 * returns the same promise.
	 */
	close(): Promise<void>;
};

/** `openFolder({ tables })`: no app ID, authentication, remote, or network. */
export type LocalFolderOptions<TTables extends Record<string, Schema>> = {
	/**
	 * The top-level directories this app reads as Markdown rows, with the
	 * schema for each row's frontmatter. Schemas interpret; they never decide
	 * what may be written.
	 */
	readonly tables: TTables;
	readonly app?: never;
	readonly id?: never;
	readonly definition?: never;
	readonly credentials?: never;
	readonly browser?: never;
};

type Files = {
	list: LocalFiles['list'];
	read: LocalFiles['read'];
	write: LocalFiles['write'];
	delete: LocalFiles['delete'];
};

export async function openLocalFolder<
	const TTables extends Record<string, Schema>,
>(
	options: LocalFolderOptions<TTables>,
): Promise<Result<Folder<TTables>, OpenFolderError>> {
	const { tables } = options;
	for (const table of Object.keys(tables))
		if (!isTableName(table)) return OpenFolderError.InvalidTable({ table });
	if (typeof indexedDB === 'undefined')
		return OpenFolderError.Unavailable({
			cause: new Error('IndexedDB is not available in this page'),
		});
	try {
		const legacy = await legacyOpfsFolders();
		if (legacy.length > 0)
			return OpenFolderError.LegacyDataPresent({ folders: legacy });
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}
	let repository: Awaited<ReturnType<typeof openRepository>>;
	try {
		repository = await openRepository(DEFAULT_KEY, tables);
	} catch (cause) {
		return OpenFolderError.Unavailable({ cause });
	}

	let closing: Promise<void> | undefined;
	const inflight = new Set<Promise<unknown>>();
	let saves = 0;
	let status: FolderStatus = {
		state: 'local',
		saving: false,
		storageFailure: null,
	};
	const statusListeners = new Set<(status: FolderStatus) => void>();

	function assertOpen() {
		if (closing !== undefined) throw new Error('The folder is closed');
	}

	function publishStatus(storageFailure = status.storageFailure) {
		const next: FolderStatus = {
			state: 'local',
			saving: saves > 0,
			storageFailure,
		};
		if (
			next.saving === status.saving &&
			next.storageFailure === status.storageFailure
		)
			return;
		status = next;
		for (const listener of [...statusListeners])
			callObserver('status listener', listener, next);
	}
	repository.onChange((change) => {
		if (change.origin === 'this-handle') publishStatus(null);
	});

	/** Track the operation so `close` can wait for it. */
	function track<T>(run: () => Promise<T>): Promise<T> {
		assertOpen();
		let resolve!: (value: T) => void;
		let reject!: (reason: unknown) => void;
		const operation = new Promise<T>((accepted, refused) => {
			resolve = accepted;
			reject = refused;
		});
		inflight.add(operation);
		const done = () => inflight.delete(operation);
		operation.then(done, done);
		// `run` can notify a status observer synchronously. That observer may
		// close the folder, so close must already see this operation.
		try {
			Promise.resolve(run()).then(resolve, reject);
		} catch (cause) {
			reject(cause);
		}
		return operation;
	}

	function read<T>(work: () => Promise<Result<T, ReadError>>) {
		return track(work);
	}

	function save<T>(work: () => Promise<Result<T, SaveError>>) {
		return track(async () => {
			saves++;
			publishStatus();
			let result: Result<T, SaveError>;
			try {
				result = await work();
			} catch (cause) {
				saves--;
				publishStatus();
				throw cause;
			}
			saves--;
			publishStatus(
				result.error === null
					? null
					: result.error.name === 'StorageFailed'
						? result.error
						: status.storageFailure,
			);
			return result;
		});
	}

	function wrapFiles(files: Files): LocalFiles {
		return {
			list: (prefix) => read(() => files.list(prefix)),
			read: (path) => read(() => files.read(path)),
			write: (path, from, content) =>
				save(() => files.write(path, from, content)),
			delete: (path, from) => save(() => files.delete(path, from)),
		};
	}

	function wrapTable(table: LocalTable): LocalTable {
		return {
			list: () => read(() => table.list()),
			get: (id) => read(() => table.get(id)),
			set: (id, from, change) => save(() => table.set(id, from, change)),
			delete: (id, from) => save(() => table.delete(id, from)),
			files: (id) => wrapFiles(table.files(id)),
		};
	}

	const folder: Folder<Record<string, Schema>> = {
		files: wrapFiles(repository.files),
		tables: Object.fromEntries(
			Object.keys(tables).map((name) => [
				name,
				wrapTable(repository.tables[name] as LocalTable),
			]),
		),
		onChange(listener) {
			assertOpen();
			return repository.onChange(listener);
		},
		get status() {
			return status;
		},
		onStatusChange(listener) {
			assertOpen();
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},
		close() {
			closing ??= (async () => {
				await Promise.allSettled([...inflight]);
				statusListeners.clear();
				repository.close();
			})();
			return closing;
		},
	};
	return Ok(folder as unknown as Folder<TTables>);
}
