/**
 * The public `Folder`: one opened, rooted set of local file paths and their
 * contents (ADR-0636). Every entry's `openFolder` returns it, whichever
 * engine holds the files: the browser's default local folder in IndexedDB
 * (`local-folder.ts`), or an ordinary directory in Bun or the desktop app
 * (`native/`).
 *
 * The handle exposes rooted `files`, table views that interpret Markdown rows
 * through the caller's schemas, one working source per path (`document`, owned by
 * the folder for its whole life, `document-owner.ts`), change notification,
 * local-save status with held input, `flush`, and `close`. A schema only
 * interprets (ADR-0632). A row that does not fit still comes back with its
 * exact source, its raw fields, and the issues, and a save never validates
 * against the schema, so unknown fields and repairable content survive.
 *
 * Writes are unconditional: a file write replaces whatever is there, a
 * delete removes it, and the last to land wins. A document save can accept
 * input and publish its captured content atomically. A row write publishes
 * a complete document without retaining failed publication as input. Every
 * write and delete of a path runs in one lane in call order and reports its
 * own outcome.
 *
 * Opening authenticates nothing, selects no remote, creates no Git history,
 * and writes no schema file (ADR-0633).
 *
 * A storage call on a released handle throws: it is a programming error, not a
 * storage failure. Held input stays readable through `getStatus` and the
 * editors. Failures that storage reports come back as `ReadError` and
 * `SaveError` results. A lost reply may follow a completed write, so failure
 * means publication could not be confirmed; accepted editor input stays held.
 */
import type { TSchema as Schema, TRecord, TUnknown } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { FileDocument, SaveFailure } from './document-owner.js';
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
 * What the handle can truthfully say about saving, held input included. A
 * save counts as saved only after storage committed it. `storageFailure` is
 * the last storage failure, cleared by a later successful write on this
 * handle.
 */
export type FolderStatus = {
	/** A write or delete admitted on this handle and not yet settled. */
	readonly saving: boolean;
	/** Paths with a write or delete admitted and not yet settled. Sorted; observing reads no files. */
	readonly savingPaths: readonly string[];
	readonly storageFailure: Extract<SaveError, { name: 'StorageFailed' }> | null;
	/** The paths with accepted input no publication has acknowledged. Sorted. */
	readonly unsaved: readonly string[];
	/** Held input whose last publication failed and that no save is retrying. */
	readonly failures: readonly SaveFailure[];
	/** Whether `close` was called: no input, action, or listener is taken from then on. */
	readonly closing: boolean;
};

/** What every engine stores files through; `FolderFiles` adds editors over them. */
export type FolderFileOperations = {
	/** Paths under `prefix`, relative to the root, sorted. */
	list(prefix?: string): Promise<Result<string[], ReadError>>;
	/** The file at `path`, or `undefined` when none exists. */
	read(
		path: string,
	): Promise<Result<{ path: string; content: Blob } | undefined, ReadError>>;
	/**
	 * Replace whatever is at `path` with `content`, or make the file. Pass
	 * bytes for binary files or to retain a byte-order mark.
	 */
	write(path: string, content: FileContent): Promise<Result<void, SaveError>>;
	/** Remove the file at `path`. A file that is not there is already gone. */
	delete(path: string): Promise<Result<void, SaveError>>;
};

export type FolderFiles = FolderFileOperations & {
	/**
	 * The shared working document of `path`, viewed through `schema`. The same
	 * path and schema answer the same handle. Acquisition reads nothing and
	 * subscribes to nothing; input lives with the folder, not a component.
	 * Throws RangeError for a structurally invalid path, before acquiring state.
	 */
	document<TSchema extends Schema = TRecord<string, TUnknown>>(
		path: string,
		schema?: TSchema,
	): FileDocument<TSchema>;
};

/** What every engine stores a table's rows through; `FolderTable` adds editors over them. */
export type FolderTableOperations<TSchema extends Schema = Schema> = {
	/** Stored rows with source, fields and issues; acquires no working documents. */
	list(): Promise<Result<Row<TSchema>[], ReadError>>;
	/** Read storage directly, independently of unsaved or retained working content. */
	get(id: string): Promise<Result<Row<TSchema> | undefined, ReadError>>;
	/**
	 * Publish a complete row from fields and body, making or replacing its file.
	 * Omitted fields and body are empty; id must be nonempty. No create-only or conflict guard.
	 * Failure accepts no pending autosave input. Answers the exact stored row.
	 */
	write(
		id: string,
		change: RowChange,
	): Promise<Result<Row<TSchema>, SaveError>>;

	/**
	 * Delete only the row file; a row that is not there is already gone.
	 * Adjacent files remain accessible through `folder.files`.
	 */
	delete(id: string): Promise<Result<void, SaveError>>;
};

export type FolderTable<TSchema extends Schema = Schema> =
	FolderTableOperations<TSchema> & {
		/**
		 * The shared document of row `id`, as `files.document` gives with this
		 * schema. Throws RangeError for an ID containing path separators or
		 * otherwise structurally invalid; existing nonportable stems remain readable.
		 */
		document(id: string): FileDocument<TSchema>;
	};

/**
 * The handle `openFolder` returns.
 *
 * Subscribe before reading: a notification means a read may now differ, and
 * `change.paths` says where (`null` when unknown).
 */
export type Folder<TTables extends Record<string, Schema>> = {
	/** Reconcile known editors: read current subscribers, mark inactive sources stale.
	 * Omit paths for all sources; paths also cover descendants. Never publishes input.
	 * Failures remain on editor snapshots; use edit.refresh() for an individual Result.
	 */
	refresh(paths?: readonly string[]): Promise<void>;
	readonly files: FolderFiles;
	readonly tables: { [TName in keyof TTables]: FolderTable<TTables[TName]> };
	/**
	 * Reports committed writes and best-effort folder-wide storage hints.
	 * Native directory events and browser broadcasts may coalesce changes;
	 * paths include affected descendants, or null when scope is unknown.
	 * The listener is not called for the current state. Returns the stop.
	 */
	onChange(listener: (change: FolderChange) => void): () => void;
	/** Current save status; subscribe with `onStatusChange` for changes. */
	getStatus(): FolderStatus;
	/** Called when save status changes. Returns the function that stops listening. */
	onStatusChange(listener: (status: FolderStatus) => void): () => void;
	/** Submit held input no admitted command owns, failed input included, without waiting. */
	flush(): void;
	/**
	 * Refuse new work and synchronously release listeners and storage, once.
	 * Stops autosave without submitting held input or waiting for admitted writes.
	 * Editors stay readable; admitted commands keep their own outcomes.
	 * Await the write or save you started when durable bytes are required.
	 */
	close(): void;
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
} & DocumentOptions;

/** How the folder's editors save accepted input. */
export type DocumentOptions = {
	/** How long after its last change input saves; `SAVE_AFTER_MS` by default. */
	readonly saveAfterMs?: number;
};

/**
 * `openFolder({ directory, tables })` in Bun: the existing directory at the
 * filesystem path `directory`.
 */
export type DirectoryFolderOptions<TTables extends FolderTables> = {
	readonly directory: string;
	readonly tables: TTables;
} & DocumentOptions;

/**
 * The opener of the browser, desktop, and automatic entries: each opens the
 * runtime's own folder and takes no directory.
 */
export type OpenFolder = <const TTables extends FolderTables>(
	options: DefaultFolderOptions<TTables>,
) => Promise<Result<Folder<TTables>, OpenFolderError>>;
