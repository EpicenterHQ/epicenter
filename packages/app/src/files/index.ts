/**
 * `@epicenter/app/files`: file-authoritative folders in the browser.
 *
 * A folder's current files are its saved data. This entry opens a browser
 * folder over IndexedDB and exports the shared vocabulary. The native opener
 * lives at `@epicenter/app/files/native` so no Node or Bun module enters a
 * browser bundle.
 */
import './buffer-global.js';
import type { DataDefinition } from '../data/definition/declaration.js';
import {
	createBrowserFileBoundary,
	type IndexedDbEnvironment,
	openFolderDatabase,
} from './browser-store.js';
import {
	assembleFolder,
	compileFolderDefinition,
	type Folder,
	type FolderGitOptions,
} from './folder.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createHistory } from './git/history.js';

export type { FileBoundary, FileListing, FileRead } from './boundary.js';
export {
	ApplyError,
	FileError,
	type FileStep,
	TableError,
	type TableReadError,
	type TableWriteError,
} from './errors.js';
export type {
	Folder,
	FolderFiles,
	FolderGit,
	FolderGitOptions,
} from './folder.js';
export type { GitRemote, PathStatus, StatusCode } from './git/backend.js';
export {
	type Activity,
	type Attempt,
	type CommitAndPushResult,
	type CommitOutcome,
	type FetchOutcome,
	type FilesObservation,
	GitError,
	type GitSnapshot,
	type Observation,
	PullError,
	type PullOutcome,
	type PushOutcome,
	type SyncObservation,
} from './git/history.js';
export { commitSubject, escapePath, type PathChange } from './git/messages.js';
export type { Author, CommitSummary } from './git/objects.js';
export type { FileKv, KvSnapshot, KvValues } from './kv.js';
export {
	frameSource,
	patchSource,
	readSource,
	type SourceChange,
} from './markdown.js';
export { pathProblem, rowPath, stemProblem } from './paths.js';
export type {
	CreateInput,
	Entry,
	EntryIssue,
	FieldsOf,
	FileTable,
	InvalidEntry,
	TableListing,
	ValidEntry,
} from './table.js';
export {
	captureVersion,
	type FileExpectation,
	type FileVersion,
	sameVersion,
} from './version.js';

export type BrowserFolderOptions<TDefinition extends DataDefinition> = {
	/** Names this browser folder's IndexedDB database. */
	readonly id: string;
	readonly definition: TDefinition;
	readonly git: FolderGitOptions;
	/** Injected IndexedDB for tests; defaults to the browser globals. */
	readonly indexedDb?: IndexedDbEnvironment;
};

/**
 * Open a browser folder. Files, directories, Git objects, refs, and the index
 * persist in one IndexedDB database named for `id`, so a reload reopens the
 * same folder and history.
 */
export async function openBrowserFolder<
	const TDefinition extends DataDefinition,
>({
	id,
	definition,
	git,
	indexedDb,
}: BrowserFolderOptions<TDefinition>): Promise<Folder<TDefinition>> {
	compileFolderDefinition(definition);
	if (id.trim() === '')
		throw new Error('A browser folder needs a nonempty id.');
	const environment: IndexedDbEnvironment = indexedDb ?? {
		indexedDB: globalThis.indexedDB,
		IDBKeyRange: globalThis.IDBKeyRange,
	};
	const db = await openFolderDatabase(`epicenter-folder:${id}`, environment);
	try {
		const boundary = createBrowserFileBoundary(db, environment);
		const backend = await createBrowserGitBackend({
			db,
			environment,
			lockName: `epicenter-folder-git:${id}`,
			branch: git.remote?.branch ?? 'main',
			remote: git.remote,
		});
		const history = createHistory({
			backend,
			boundary,
			author: git.author,
			commitOnEdit: git.commitOnEdit ?? true,
		});
		return assembleFolder({
			definition,
			boundary,
			history,
			release: async () => db.close(),
		});
	} catch (cause) {
		db.close();
		throw cause;
	}
}
