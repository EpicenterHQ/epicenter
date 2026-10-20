/**
 * The public `Folder`: one opened, rooted set of local file paths and their
 * contents (ADR-0636). Every entry's `openFolder` returns it, whichever
 * engine holds the files: the browser's default local folder in IndexedDB
 * (`local-folder.ts`), or an ordinary directory in Bun or the desktop app
 * (`native/`).
 *
 * The handle exposes rooted `files`, table views that interpret Markdown rows
 * through the caller's schemas, change notification, local-save status, and
 * `close`. A schema only interprets (ADR-0632). A row that does not fit still
 * comes back with its exact source, its raw fields, and the issues, and a
 * save never validates against the schema, so unknown fields and repairable
 * content survive. Each edit names the content it started from, and the
 * engine merges it with whatever else was saved meanwhile, by the same rules
 * on every host (`shared/merge.ts`, `shared/row.ts`).
 *
 * Opening authenticates nothing, selects no remote, creates no Git history,
 * and writes no schema file (ADR-0633).
 *
 * A call on a closed handle throws: it is a programming error, not a storage
 * failure. Failures that storage reports come back as `ReadError` and
 * `SaveError` results; a failed save leaves earlier storage unchanged.
 */
import type { TSchema as Schema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { OpenFolderError } from './errors.js';
import type { ReadError, SaveError } from './shared/errors.js';
import type { FileContent } from './shared/merge.js';
import type { Issue, Row, RowChange } from './shared/row.js';

export type { FileContent, Issue, ReadError, Row, RowChange, SaveError };

/** A committed change to file contents, from this handle or from another. */
export type FolderChange = {
	/** The paths written, or `null` when any path may differ. */
	readonly paths: readonly string[] | null;
	readonly origin: 'this-handle' | 'other-handle';
};

/**
 * What the handle can truthfully say about saving. A save counts as saved
 * only after storage committed it. `storageFailure` is the
 * last storage failure, cleared by a later successful save on this handle,
 * including a retry whose desired content is already stored. Individual
 * refusals and unsaved drafts belong to their callers.
 */
export type FolderStatus = {
	/** Saves started on this handle and not yet committed or refused. */
	readonly saving: boolean;
	readonly storageFailure: Extract<SaveError, { name: 'StorageFailed' }> | null;
};

export type FolderFiles = {
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

export type FolderTable<TSchema extends Schema = Schema> = {
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
		from: Pick<Row, 'text' | 'issues'> | null,
		change: RowChange,
	): Promise<Result<{ sent: Row<TSchema> }, SaveError>>;
	/** Delete only the row file. Adjacent files remain accessible through `folder.files`. */
	delete(
		id: string,
		from: Pick<Row, 'text' | 'issues'> | null,
	): Promise<Result<{ deleted: boolean }, SaveError>>;
};

/**
 * The handle `openFolder` returns.
 *
 * Subscribe before reading: a notification means a read may now differ, and
 * `change.paths` says where (`null` when unknown).
 */
export type Folder<TTables extends Record<string, Schema>> = {
	readonly files: FolderFiles;
	readonly tables: { [TName in keyof TTables]: FolderTable<TTables[TName]> };
	/**
	 * Called after a save commits, whether this handle or another one made
	 * it. Native handles report participating handles in this page/process,
	 * not arbitrary external programs; UI queries poll for those edits.
	 * The listener is not called for the current state. Returns the stop.
	 */
	onChange(listener: (change: FolderChange) => void): () => void;
	readonly status: FolderStatus;
	/** Called when `status` changes. Returns the function that stops listening. */
	onStatusChange(listener: (status: FolderStatus) => void): () => void;
	/**
	 * Close the handle. New calls throw at once; saves already started finish
	 * and report their real outcome; then listeners are released and storage
	 * is released. Saved work stays saved. Closing again returns the same
	 * promise.
	 */
	close(): Promise<void>;
};

/**
 * The top-level directories an app reads as Markdown rows, with the schema
 * for each row's frontmatter. Schemas interpret; they never decide what may
 * be written.
 */
export type FolderTables = Record<string, Schema>;

/**
 * `openFolder({ tables })`: the runtime's own folder. In a browser it is this
 * origin's one local folder, reopened under a fixed internal key. In the
 * desktop app it is the directory the shell bound to this window before the
 * window existed; the page names none.
 */
export type DefaultFolderOptions<TTables extends FolderTables> = {
	readonly tables: TTables;
	readonly directory?: never;
};

/**
 * `openFolder({ directory, tables })` in Bun: the existing directory at the
 * filesystem path `directory`.
 */
export type DirectoryFolderOptions<TTables extends FolderTables> = {
	readonly directory: string;
	readonly tables: TTables;
};

/**
 * The opener of the browser, desktop, and automatic entries: each opens the
 * runtime's own folder and takes no directory.
 */
export type OpenFolder = <const TTables extends FolderTables>(
	options: DefaultFolderOptions<TTables>,
) => Promise<Result<Folder<TTables>, OpenFolderError>>;
