/**
 * The folder contract: everything an application names besides the opener.
 *
 * `@epicenter/folder`, `/browser`, `/tauri`, and `/bun` all export this
 * module unchanged, so code written against one entry type-checks against the
 * others, and an explicit entry never pulls the automatic selector into its
 * graph.
 *
 * This module is inert. Importing it opens nothing and loads no storage, no
 * Git implementation, and no runtime-specific module.
 */
import type { Result } from 'wellcrafted/result';
import type { FolderDefinition } from './definition.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { GitCredentials, HttpFetch } from './git/http.js';
import type { Author } from './git/objects.js';
import type { OpfsEnvironment } from './opfs-store.js';

export {
	type CreateRowOf,
	defineTable,
	field,
	type KvOf,
} from '@epicenter/definition';
export type { FileListing } from './boundary.js';
export {
	type CapturedFile,
	type FileCapture,
	hashBytes,
	submittedText,
	type TextCapture,
} from './capture.js';
export { formatDeclaration, parseDeclaration } from './declaration.js';
export {
	defineFolder,
	type FolderDefinition,
	type FolderTable,
	type PreparedFolderTable,
} from './definition.js';
export {
	FileError,
	type FileStep,
	type KvReadError,
	type KvWriteError,
	MoveError,
	OpenFolderError,
	type RowReadError,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	TableError,
	type TableReadError,
	type TableRenameError,
	type TableReplaceError,
	type TableWriteError,
} from './errors.js';
export type { FolderFiles } from './files.js';
export type {
	Folder,
	FolderAccess,
	FolderGit,
	FolderGitOptions,
	FolderLocation,
	FolderSync,
} from './folder.js';
export type {
	GitRemote,
	PathStatus,
	StatusCode,
} from './git/backend.js';
export {
	CONFLICTS_NEED_SYNC,
	type ConflictVersion,
	GitError,
	type MergeConflict,
	MergeError,
	PullError,
	type SyncChoiceProblem,
	SyncError,
} from './git/errors.js';
export type {
	Activity,
	Attempt,
	CommitAndPushResult,
	CommitOutcome,
	FetchOutcome,
	FilesObservation,
	GitSnapshot,
	MergeConflictPolicy,
	MergeOutcome,
	Observation,
	PullOutcome,
	PushOutcome,
	StagedCommit,
	SyncObservation,
} from './git/history.js';
export type {
	GitCredential,
	GitCredentials,
	HttpFetch,
} from './git/http.js';
export {
	type LineVersions,
	mergeLinesPreferring,
	type PreferredMerge,
} from './git/merge-lines.js';
export { commitSubject, escapePath, type PathChange } from './git/messages.js';
export type { Author, CommitSummary } from './git/objects.js';
export type {
	SyncAttempt,
	SyncChoice,
	SyncChoices,
	SyncConflict,
	SyncOptions,
	SyncOutcome,
	SyncSide,
	SyncVersion,
} from './git/sync.js';
export type { FileKv, KvReading } from './kv.js';
export { type KvMerge, type KvMergeInput, mergeKv } from './kv-merge.js';
export { frameRowText, type RowTextFrame } from './markdown.js';
export type {
	OpfsDirectoryHandle,
	OpfsEnvironment,
	OpfsFileHandle,
	OpfsLocks,
} from './opfs-store.js';
export {
	DECLARATION_PATH,
	pathProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
export {
	describeTables,
	type ProjectedTable,
	projectionProblem,
	projectTables,
	readingStatementProblem,
	type SqlTarget,
} from './projection.js';
export {
	type AnyRow,
	type BodyConflict,
	type FieldConflict,
	mergeRow,
	type RowMerge,
	type RowVersions,
} from './row-merge.js';
export {
	formatRow,
	type Issue,
	type Issues,
	parseRow,
	type Row,
	wellFormed,
} from './row-text.js';
export type { FileTable, StoredRow, TableListing } from './table.js';

/**
 * Settings for a folder kept in this browser's own storage. They apply to a
 * browser folder only. A folder in the desktop app takes its directory and
 * fallback author from the shell that registered it, and its remote from its
 * own Git configuration.
 */
export type BrowserFolderOptions = {
	/**
	 * Author and committer of the commits this browser records. Defaults to a
	 * local identity.
	 */
	readonly author?: Author;
	/**
	 * Fetch-compatible HTTP transport used for Git fetch and push. An application
	 * can route the remote through its authenticated relay without replacing
	 * the page's fetch. Defaults to global fetch and receives the operation's
	 * abort signal. Authentication belongs to the supplied transport, not to
	 * the folder or its Git configuration.
	 */
	readonly httpFetch?: HttpFetch;
	/**
	 * Injected origin private file system, Web Locks, and hint channel; for
	 * tests. Defaults to the browser globals.
	 */
	readonly opfs?: OpfsEnvironment;
};

export type OpenFolderOptions<TDefinition extends FolderDefinition> = {
	/** How this caller reads the folder's files. It names no folder. */
	readonly definition: TDefinition;
	/**
	 * Which folder to open, such as `so.epicenter.todos`. Required, and never
	 * a path. A browser names its directory after it; the desktop shell maps
	 * it to a directory it registered.
	 */
	readonly id: string;
	/**
	 * Asked right before each push and fetch with the exact URL Git is about
	 * to reach, in the browser and on the desktop. Return `undefined` to send
	 * no credential (a desktop `git` then uses the person's own credential
	 * helper or SSH key).
	 */
	readonly credentials?: GitCredentials;
	readonly browser?: BrowserFolderOptions;
};

/**
 * The one opener signature. The automatic entry, the browser entry, and the
 * desktop entry each export an `openFolder` of exactly this type.
 */
export type OpenFolder = <const TDefinition extends FolderDefinition>(
	options: OpenFolderOptions<TDefinition>,
) => Promise<Result<Folder<TDefinition>, OpenFolderError>>;

/**
 * Which existing folder `openDataFolder` opens: `openFolder`'s options
 * without a definition, since the folder's own `epicenter.json` is its
 * schema.
 */
export type OpenDataFolderOptions = Omit<
	OpenFolderOptions<FolderDefinition>,
	'definition'
>;

/**
 * Open a folder that already exists with the schema in its own
 * `epicenter.json`, which the handle never writes. A folder without one opens
 * with no tables and no settings; files, history, and Sync work. Rows are
 * checked at run time, so tables are keyed by any name. The automatic, the
 * browser, and the desktop entry each export an `openDataFolder` of exactly
 * this type.
 */
export type OpenDataFolder = (
	options: OpenDataFolderOptions,
) => Promise<Result<Folder<FolderDefinition>, OpenFolderError>>;
