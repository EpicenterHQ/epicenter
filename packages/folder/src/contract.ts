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
import type { TSchema as Schema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { Definition } from './definition.js';
import type { OpenFolderError } from './errors.js';
import type { Folder } from './folder.js';
import type { GitCredentials, HttpFetch } from './git/http.js';
import type { Author } from './git/objects.js';
import type { LocalFolder, LocalFolderOptions } from './local-folder.js';
import type { OpfsEnvironment } from './opfs-store.js';

export { type CreateRowOf, defineTable, field } from '@epicenter/definition';
export type { FileListing, FileRead } from './boundary.js';
export { formatDefinition, parseDefinition } from './declaration.js';
export {
	type Definition,
	defineFolder,
	type FolderTable,
	type PreparedFolderTable,
} from './definition.js';
export {
	FileError,
	OpenFolderError,
	RowReadError,
	RowWriteError,
	WriteError,
} from './errors.js';
export type { FolderFiles } from './files.js';
export type {
	FilesChanged,
	Folder,
	FolderGit,
	FolderGitOptions,
	FolderLocation,
	FolderSync,
} from './folder.js';
export type { GitRemote } from './git/backend.js';
export { GitError, type GitInstall, SyncError } from './git/errors.js';
export type {
	Activity,
	Attempt,
	CommitOutcome,
	FilesObservation,
	GitSnapshot,
	Observation,
	PushOutcome,
	SyncObservation,
} from './git/history.js';
export type {
	GitCredential,
	GitCredentials,
	HttpFetch,
} from './git/http.js';
export type { PathChange } from './git/messages.js';
export type { Author, CommitSummary } from './git/objects.js';
export type { SyncOptions, SyncOutcome } from './git/sync.js';
export { hashBytes } from './hash.js';
export { frameRowText } from './markdown.js';
export type {
	FolderChange,
	FolderStatus,
	LocalFiles,
	LocalFolder,
	LocalFolderOptions,
	LocalIssue,
	LocalRow,
	LocalRowChange,
	LocalTable,
	ReadError,
	SaveError,
} from './local-folder.js';
export type { FileContent, Overridden } from './merge-file.js';
export {
	DEFINITION_PATH,
	pathProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
export { describeTables } from './projection.js';
export {
	formatRow,
	type Issue,
	type Issues,
	parseRow,
	type Row,
	wellFormed,
} from './row-text.js';
export {
	type FileTable,
	isStoredRow,
	type StoredRow,
	type TableListing,
	type UnreadableRow,
	type WrittenRow,
} from './table.js';
export type { Written } from './write.js';

/**
 * Settings for a folder kept in this browser's own storage. They apply to a
 * browser folder only. A folder in the desktop app takes its directory from
 * the shell that registered it, and its remote and author from its own Git
 * configuration.
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
	 * Injected origin private file system, Web Locks, change channel, and
	 * page events; for tests. Defaults to the browser globals.
	 */
	readonly opfs?: OpfsEnvironment;
};

/**
 * What opening a folder needs besides which folder: the browser's settings
 * and the credentials a browser folder's Git sends.
 */
type HostOptions = {
	/**
	 * Asked right before each push and fetch with the exact URL Git is about
	 * to reach, in the browser. Return `undefined` to send no credential. The
	 * desktop app ignores it: the `epicenter` CLI sends its own token to the
	 * deployment's Git, and the person's own credential helper or SSH key
	 * serves any other remote.
	 */
	readonly credentials?: GitCredentials;
	readonly browser?: BrowserFolderOptions;
};

/**
 * TEMPORARY MIGRATION BOUNDARY: the declaration-dependent open shapes.
 *
 * `{ app, definition }`, `{ id, definition }`, and `{ id }` open a folder kept
 * in OPFS (browser), a granted directory (desktop), or a path (Bun), and they
 * publish or read `epicenter.json`. They exist so apps that predate
 * ADR-0632/0633/0636 keep building. The chosen contract is
 * `openFolder({ tables })` (`LocalFolderOptions`), which returns a
 * `LocalFolder`. Remove `OpenFolderOptions`, `DefinedFolderOptions`,
 * `DeclaredFolderOptions`, the first two `OpenFolder` overloads, and the
 * OPFS/declaration adapters when no app or tool calls them; then rename
 * `LocalFolder` to `Folder`. Old stored data is not read by the new shape.
 *
 * Which folder to open, and the definition to read it through.
 *
 * One rule decides what the handle does with the definition: a folder's
 * `epicenter.json` is published by the app the folder is named after, and
 * every other opener reads through its definition. A folder read through a
 * definition must declare everything the definition does (ADR-0538), or it
 * is `DefinitionMismatch`; the handle has the definition's tables, every
 * write is still checked against the folder's own definition, and
 * `epicenter.json` is never written.
 *
 * - `{ app, definition }`: an app opening its folder. `app` is the app's
 *   id, as its manifest names it, such as `so.epicenter.todos`. On the
 *   desktop the app opens the folder the shell handed its window, which the
 *   shell answers the page (`window_folder`), and a window the shell opened
 *   for another app, or for none, is refused (`AppMismatch`); in a browser
 *   it opens its own. Its own folder is the one named after `app`, and only
 *   there is `definition` published.
 * - `{ id }`: the folder named `id`, read with its own `epicenter.json`
 *   (none means no tables; its tables are then keyed by any name and checked
 *   at run time). For the Folders window, the CLI, and tools.
 * - `{ id, definition }`: the folder named `id`, read through `definition`
 *   and never published, such as an app reading Epicenter's own folder.
 *
 * An `id` is never a path. A browser names its directory after it; the
 * desktop shell maps it to a directory it registered.
 */
export type OpenFolderOptions<TDefinition extends Definition = Definition> =
	| DefinedFolderOptions<TDefinition>
	| DeclaredFolderOptions;

/** The forms that read a folder through a definition: `{ app }` and `{ id }`. */
export type DefinedFolderOptions<TDefinition extends Definition> = HostOptions &
	(
		| {
				readonly app: string;
				readonly definition: TDefinition;
				readonly id?: never;
		  }
		| {
				readonly id: string;
				readonly definition: TDefinition;
				readonly app?: never;
		  }
	);

/** `{ id }` alone: the folder read with its own `epicenter.json`. */
export type DeclaredFolderOptions = HostOptions & {
	readonly id: string;
	readonly definition?: undefined;
	readonly app?: never;
};

/** Every shape an opener may receive, for the adapters that dispatch on it. */
export type AnyFolderOptions =
	| OpenFolderOptions
	| LocalFolderOptions<Record<string, Schema>>;

/**
 * The temporary migration boundary's two call signatures (see
 * `DefinedFolderOptions`). Removed with it.
 */
export type OpenLegacyFolder = {
	<const TDefinition extends Definition>(
		options: DefinedFolderOptions<TDefinition>,
	): Promise<Result<Folder<TDefinition, Definition>, OpenFolderError>>;
	(
		options: DeclaredFolderOptions,
	): Promise<Result<Folder<Definition>, OpenFolderError>>;
};

/**
 * The one opener signature. Every entry but `/bun`, which opens a directory
 * by its path, exports an `openFolder` of exactly this type.
 *
 * `{ tables }` is the chosen shape: this origin's default local folder
 * (browser only for now), needing no app ID, authentication, remote, or
 * network. For the legacy forms, the handle's `definition` is the folder's
 * own definition wherever the folder is not the app's own, so it is typed as
 * any definition. Without a definition the tables are the folder's own,
 * typed as any, whatever a caller claims.
 */
export type OpenFolder = {
	<const TTables extends Record<string, Schema>>(
		options: LocalFolderOptions<TTables>,
	): Promise<Result<LocalFolder<TTables>, OpenFolderError>>;
} & OpenLegacyFolder;
