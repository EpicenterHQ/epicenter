/**
 * The opened folder handle every opener returns (ADR-0471, ADR-0478).
 *
 * `write` is the one write and `move` the one move (ADR-0576), and
 * `tables` publish through the same file boundary, one file change per
 * operation; `files` reads files and keeps directories. A caller that
 * needs several changes makes several calls; each one that succeeded stays
 * published when a later one fails.
 * `git` observes and records history. A save never commits: commits happen
 * only through `git.commit()` or sync's checkpoint (ADR-0529).
 *
 * Closing fences new file work and this handle's history requests at once,
 * cancels pending history and network work, then drains admitted Git work.
 * Each file operation owns its completion promise. Closing does not wait for
 * file helpers; storage applications already started return their actual
 * outcome. Closing makes no last commit.
 */
import { type CreateRowOf, requiredOutsideShape } from '@epicenter/definition';
import type { Result } from 'wellcrafted/result';
import { type FolderStorage, mayHaveChanged } from './boundary.js';
import type { FolderDefinition, PreparedFolderTable } from './definition.js';
import { FileError, type WriteError } from './errors.js';
import { createFiles, type FolderFiles } from './files.js';
import type { SyncError } from './git/errors.js';
import type {
	CommitOutcome,
	FilesObservation,
	GitError,
	GitSnapshot,
} from './git/history.js';
import type { GitCredentials } from './git/http.js';
import type { Author, CommitSummary } from './git/objects.js';
import type { SyncOptions, SyncOutcome } from './git/sync.js';
import { type FileContent, fileKindOf } from './merge-file.js';
import { callObserver } from './observer.js';
import {
	publishDefinition,
	publishLocalPatterns,
} from './publish-definition.js';
import { createTable, type FileTable } from './table.js';
import { movePath, type Written, writeFile } from './write.js';

/** History settings for a folder whose history this process records. */
export type FolderGitOptions = {
	/** Author and committer for the folder's commits. */
	readonly author: Author;
	/** Asked before each push and fetch; see `GitCredentials`. */
	readonly credentials?: GitCredentials;
};

/**
 * A folder's history on every host: what changed, the versions, and saving
 * one. Sync (`folder.sync`) is how a folder exchanges history with its
 * remote, on every host the same way.
 */
export type FolderGit = {
	readonly snapshot: GitSnapshot;
	/** Delivers the current snapshot synchronously, then each change. */
	subscribe(listener: (snapshot: GitSnapshot) => void): () => void;
	/** A fresh inspection of uncommitted changes and local/remote heads. */
	status(): Promise<Result<FilesObservation, GitError>>;
	/**
	 * Commit current source files if they changed, and reset the index to the
	 * head either way. Never pushes. `message` is a person's own; without it
	 * the message names what changed.
	 */
	commit(options?: { message?: string }): Promise<CommitOutcome>;
	log(depth: number): Promise<Result<CommitSummary[], GitError>>;
};

/**
 * Synchronization with the configured remote branch (ADR-0576). It never
 * stops because changes compete: the device syncing is the writer acting.
 *
 * ```ts
 * const { data: done, error } = await folder.sync.run();
 * if (error !== null) return show(error.message);
 * done.kind; // 'synced', or 'saved' when the remote may not have it yet
 * ```
 *
 * Browser and directory folders implement it, the desktop folder included.
 */
export type FolderSync = {
	/**
	 * Commit saved files, fetch the remote branch, and bring the two
	 * together: a fast-forward, a push, or one merge commit of both heads,
	 * pushed before its files are written here. Units only one side changed
	 * merge; where both changed one, this device's side wins, and the merge
	 * commit names what lost. A delete beats an edit it never saw.
	 */
	run(options?: SyncOptions): Promise<Result<SyncOutcome, SyncError>>;
	/**
	 * Make `url` the folder's remote (`remote.origin.url` in its Git
	 * configuration), then sync. This is how a folder gets a remote, or
	 * changes it. An empty folder takes the remote's history; a folder with
	 * files and no history of its own merges them with it; a remote with no
	 * branch receives this folder's. Separate histories are `Unrelated` until
	 * `allowUnrelatedHistories` combines them. The remote stays set whatever
	 * the sync answers, and a later `run` continues.
	 */
	connect(
		url: string,
		options?: SyncOptions,
	): Promise<Result<SyncOutcome, SyncError>>;
};

/** Borrowed data access; the object that opened the folder owns its lifetime. */
export type FolderAccess<TDefinition extends FolderDefinition> = {
	readonly tables: {
		readonly [K in keyof TDefinition['tables']]: FileTable<
			CreateRowOf<TDefinition['tables'][K]>
		>;
	};
	readonly files: FolderFiles;
	readonly git: FolderGit;
	/**
	 * The one write (ADR-0576): read the file at `path` as it is now, merge
	 * the change from `from` to `to` into it by the file's kind, and put the
	 * result guarded by what was read, again when another writer landed in
	 * between, at most `WRITE_ATTEMPTS` times.
	 *
	 * Units only one side changed survive; where both changed one unit
	 * differently, this write wins, and `overridden` names each such unit,
	 * which is also logged. Two insertions at one place both survive. A row
	 * is written in canonical form. A version that does not read as its kind
	 * merges as text, so the result may be a file to repair; nothing is
	 * refused for it.
	 *
	 * `from` is the content the change started from, or `null` for no file
	 * (a create). `to` is the new content, or `null` to delete the file,
	 * which the deleter wins whatever `from` is. Any `to` is written, read
	 * as its kind or not. Strings are written as UTF-8; byte arrays are
	 * copied when it is called.
	 */
	write(
		path: string,
		from: FileContent | null,
		to: FileContent | null,
	): Promise<Result<Written, WriteError>>;
	/**
	 * Move the file at `path` to `next`, as it is (ADR-0576): its bytes land
	 * at `next` only where nothing is, then `path` is removed only while it
	 * holds them, a write that lands there meanwhile carried along first. A
	 * move changes where a file is, not what it holds, so it merges nothing.
	 * No file at `path`, or one already at `next`, is `InvalidPath`, as is
	 * another writer changing `next` while the file moved there, which
	 * leaves the file at `path`. `KeptChanging`, or a removal that failed,
	 * leaves the file at both paths, to repair. Answers the file as it
	 * stands at `next`.
	 */
	move(path: string, next: string): Promise<Result<Written, WriteError>>;
};

/**
 * Where an opened folder's files are. For showing to a person or telling
 * folders apart; file paths passed to the folder are never joined onto it.
 */
export type FolderLocation =
	/** A directory of this origin's private file system, by its path from the root. */
	| { readonly kind: 'opfs'; readonly directory: string }
	/** An ordinary directory, by absolute path. */
	| { readonly kind: 'directory'; readonly root: string };

/**
 * An opened folder. `TDefinition` types `tables`; `TDeclared` types
 * `definition`, and differs from it only for a lens, whose tables are typed by
 * the lens while the handle reads and writes with the folder's own
 * declaration.
 */
export type Folder<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
> = FolderAccess<TDefinition> & {
	readonly git: FolderGit;
	/**
	 * The prepared definition this handle reads with: the one `openFolder`
	 * was given, or the folder's own `epicenter.json` as `openDataFolder`
	 * read it when it opened (no tables when there was none), lens or not.
	 * Every row is checked against it, and Sync merges rows by it. A
	 * declaration changed after opening is read by the next open.
	 */
	readonly definition: TDeclared;
	readonly location: FolderLocation;
	readonly sync: FolderSync;
	/**
	 * Hear that files may have changed, as a reason to read again (ADR-0548).
	 * `change` is the paths a change reached, or `'everything'` when the
	 * reporter cannot say which. A call carries no content; read through
	 * the folder to learn what the files hold.
	 *
	 * Reports come from the host's one detector of changes made outside
	 * this handle, and from incoming updates this handle's own Sync wrote.
	 * In a browser the detector is other pages of this origin, which tell
	 * the paths they write; on the desktop it is the shell's watcher of the
	 * granted directory; in Bun there is none. This handle's own saves are
	 * not reported: whoever saved holds the result.
	 *
	 * Nothing records reports, so one missed costs a delay, never data.
	 * Subscribe before the first read so no change falls between them.
	 * Returns the function that stops listening; closing stops all of them.
	 */
	onFilesChanged(listener: (change: FilesChanged) => void): () => void;
	/** Aborts when closing starts. */
	readonly signal: AbortSignal;
	/**
	 * Fence the next storage call and drain owned Git work before release.
	 * Await each file operation that must finish before closing; close does
	 * not wait for file helpers or their publication replies.
	 */
	close(): Promise<void>;
};

/** The history a handle is assembled over. */
export type FolderHistory = FolderGit & {
	readonly sync: FolderSync;
	/** The files changed outside the history; its observations are stale. */
	noteEdit(): void;
	close(): Promise<void>;
};

/** Which files changed: their paths, or `'everything'` when a report cannot say. */
export type FilesChanged = readonly string[] | 'everything';

/** Reports of file changes for one opened folder. */
type FileHints = {
	/** Files changed: tell every listener. An empty list is no change. */
	report(change: FilesChanged): void;
	subscribe(listener: (change: FilesChanged) => void): () => void;
	/** Stop calling this handle's listeners and drop them. */
	close(): void;
};

export function createFileHints(): FileHints {
	const listeners = new Set<(change: FilesChanged) => void>();
	let closed = false;
	return {
		report(change) {
			if (change !== 'everything' && change.length === 0) return;
			const reported =
				change === 'everything' ? change : Object.freeze([...change]);
			// A listener may close the folder or stop another listener. The ones
			// after it are asked again before each call, so neither hears a
			// report it was fenced from, and one that throws does not silence
			// the rest.
			for (const listener of [...listeners]) {
				if (closed) return;
				if (listeners.has(listener))
					callObserver('change listener', listener, reported);
			}
		},
		subscribe(listener) {
			if (closed) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close() {
			closed = true;
			listeners.clear();
		},
	};
}

/**
 * The storage a handle's files, tables, and writes go through, over the
 * host's. A call made once closing started is `Closed`; one already begun
 * owns its result. With `published`, the handle publishes that definition
 * just before its first change (`publish-definition.ts`), through the same
 * accounting. Each put that changed a file, or may have, makes the history's
 * observations stale; it is not reported to the handle's own listeners
 * (ADR-0548), since whoever saved holds the result.
 */
function handleStorage(
	storage: FolderStorage,
	{
		signal,
		history,
		published,
	}: {
		signal: AbortSignal;
		history: Pick<FolderHistory, 'noteEdit'>;
		published: FolderDefinition | undefined;
	},
): FolderStorage {
	const closed = () => Promise.resolve(FileError.Closed());
	const noting: Pick<FolderStorage, 'read' | 'put'> = {
		read: (path) => storage.read(path),
		async put(path, bytes, ifMatch) {
			const result = await storage.put(path, bytes, ifMatch);
			if (mayHaveChanged(result)) history.noteEdit();
			return result;
		},
	};
	let publishing: Promise<void> | undefined;
	const publish = async () => {
		if (published === undefined) return;
		publishing ??= publishDefinition(published, noting).then((local) =>
			publishLocalPatterns(local, noting),
		);
		await publishing;
	};
	return {
		list: () => (signal.aborted ? closed() : storage.list()),
		children: (directory) =>
			signal.aborted ? closed() : storage.children(directory),
		read: (path) => (signal.aborted ? closed() : storage.read(path)),
		async put(path, bytes, ifMatch) {
			if (signal.aborted) return closed();
			await publish();
			return noting.put(path, bytes, ifMatch);
		},
		async mkdir(path) {
			if (signal.aborted) return closed();
			await publish();
			return storage.mkdir(path);
		},
		rmdir: (path) => (signal.aborted ? closed() : storage.rmdir(path)),
	};
}

/** The handle's `git`, frozen, over `history`. */
function createFolderGit(history: FolderHistory): FolderGit {
	return Object.freeze({
		get snapshot() {
			return history.snapshot;
		},
		subscribe: (listener) => history.subscribe(listener),
		status: () => history.status(),
		commit: (options) => history.commit(options),
		log: (depth) => history.log(depth),
	} satisfies FolderGit);
}

/**
 * Assemble the handle over acquired storage. `prepared` is the prepared
 * definition: `openFolder`'s `prepareFolderDefinition` result, or the
 * declaration `openDataFolder` read. It is the snapshot every table reads
 * through, never the declaration the opener was handed. No argument
 * carries `TDefinition`, so the opener names it.
 *
 * With a `lens` that `prepared` contains, the handle has the lens's tables
 * alone, each still reading and writing through `prepared`'s table, so a row
 * is checked against every field the folder declares and keeps the fields
 * the lens does not name.
 */
export function assembleFolder<
	TDefinition extends FolderDefinition,
	TDeclared extends FolderDefinition = TDefinition,
	THistory extends FolderHistory = FolderHistory,
>({
	prepared,
	lens,
	publishes,
	storage: suppliedStorage,
	history,
	location,
	hints,
	release,
}: {
	prepared: FolderDefinition;
	/** The shape the caller reads, contained by `prepared` (ADR-0538). */
	lens?: FolderDefinition;
	/**
	 * Whether the handle publishes `prepared` to `epicenter.json` before its
	 * first write. `openFolder`'s handles do; `openDataFolder`'s, whose
	 * definition is that file, never write it.
	 */
	publishes: boolean;
	/** The host's storage, which the history shares. */
	storage: FolderStorage;
	history: THistory;
	location: FolderLocation;
	hints: FileHints;
	/** Releases this attachment after owned Git work settles. */
	release: () => Promise<void>;
}): Folder<TDefinition, TDeclared> {
	const controller = new AbortController();
	let closing: Promise<void> | undefined;

	const storage = handleStorage(suppliedStorage, {
		signal: controller.signal,
		history,
		published: publishes ? prepared : undefined,
	});
	const tables: Record<string, FileTable<unknown>> = {};
	// A table's key is its name and its directory.
	// The opener prepared every table, which is what the type's mark records.
	for (const name of Object.keys((lens ?? prepared).tables)) {
		const table = prepared.tables[name] as PreparedFolderTable;
		const shape = lens?.tables[name];
		tables[name] = createTable<unknown>(
			{ storage },
			name,
			table,
			shape === undefined
				? []
				: Object.freeze(requiredOutsideShape(table, shape)),
		);
	}
	const files = createFiles({ storage });
	const git = createFolderGit(history);

	return Object.freeze({
		definition: prepared as TDeclared,
		tables: Object.freeze(tables) as Folder<TDefinition>['tables'],
		files,
		git,
		write: (path: string, from: FileContent | null, to: FileContent | null) =>
			writeFile(storage, fileKindOf(prepared, path), path, from, to),
		move: (path: string, next: string) => movePath(storage, path, next),
		location: Object.freeze(location),
		sync: history.sync,
		onFilesChanged: (listener: (change: FilesChanged) => void) =>
			hints.subscribe(listener),
		signal: controller.signal,
		close() {
			if (closing !== undefined) return closing;
			const completion = Promise.withResolvers<void>();
			// Abort and history observers may call close again synchronously.
			// Give them this completion before notifying either one.
			closing = completion.promise;
			void (async () => {
				// Fence new file work and hints, then close this handle's history.
				controller.abort();
				hints.close();
				await history.close();
				await release();
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	} satisfies Folder<TDefinition, TDeclared>);
}
