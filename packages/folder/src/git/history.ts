/**
 * History coordination for one directory (ADR-0468, ADR-0469, ADR-0471,
 * ADR-0576), as the `epicenter` CLI runs it (`runHistory` in `bun.ts`). Git
 * is not on a `Folder`'s lifetime (ADR-0636); this is kept for exchange.
 *
 * File saves never wait here. A commit captures the whole portable folder,
 * writes blobs and trees, writes a commit on the pinned branch head, and
 * moves the branch with a compare-and-swap. It never reads or writes the
 * shared index to build that commit. A moved branch leaves the candidate
 * unreachable and is retried once from a fresh capture; a second move is
 * reported (ADR-0541).
 *
 * The backend's exclusive protection is the only thing that orders commits
 * and publishing: in this handle, and in the browser across tabs. Handles of
 * a directory folder meet at Git's lock files and the branch's
 * compare-and-swap. A commit happens only when asked, by `commit` or by
 * sync's checkpoint (ADR-0529); a save never asks for one.
 *
 * `sync.run()` never stops because changes compete. It checkpoints saved
 * files, fetches, and then fast-forwards, pushes, or makes one merge commit
 * of the local head and the remote's (`mergeHistories`) by the rules the
 * browser's Sync uses: the merge base, the remote's tree as current, and
 * this device's as the change. A merge commit is pushed before anything here
 * changes, so a push that lost a race leaves nothing to undo: Sync fetches
 * and merges again from the same local head. A tree that lands is published
 * over the files by the one write, holding the folder's save lock: the
 * checkpoint's file is the base, the merged tree's the current file, and the
 * live file the change, so text typed while Sync runs stands. Each write
 * lands whole, so a publish cut off partway is ordinary changed files, which
 * the next Sync records and merges (ADR-0545).
 *
 * What stays local is the `local` list of the folder's `epicenter.json`
 * (ADR-0577), read strictly (`parseLocalPolicy`). A commit reads it from the
 * very bytes it records, so its own file names every path it leaves out.
 * A history keeps every pattern it has seen, so a rule removed while it runs
 * still holds, and a rule the remote's file newly declares (against the
 * merge base, or the head Sync fast-forwards from) keeps the remote's files
 * off this disk and out of the merge. Sync never weakens this folder's rules
 * on its own: an incoming or merged file that drops a rule this folder's
 * file still lists, or one the remote newly declares, stops it before a
 * push, and so does none at all where the history opened with one. The
 * publish checks again as it writes the file, in the save lock's hold and
 * against the live bytes it replaces, so a rule saved here while Sync runs
 * survives the publish or stops it before any local file changes; a merge
 * may already have been pushed. Nor does it send a commit the remote lacks
 * that adds or changes a path a rule seen keeps local, however clean the
 * latest tree; it never rewrites history to remove one. No app's table
 * schemas are read here.
 *
 * Status scans take no protection. Callers who ask while a scan is running
 * share the one scan that follows it, so a burst of requests costs two scans
 * and the last one reads the folder after every request was made.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, LockingStorage } from '../boundary.js';
import { parseLocalPolicy, readLocalPolicy } from '../declaration.js';
import { describe, FileError, UnconfirmedWrite } from '../errors.js';
import { callObserver } from '../observer.js';
import {
	ancestors,
	collisionKey,
	DEFINITION_PATH,
	isPortablePath,
	pathProblem,
} from '../paths.js';
import { sameContent } from '../shared/merge.js';
import { confirmedPut, publishFile } from '../write.js';
import { declaredFilter, isAttributesPath } from './attributes.js';
import type { GitBackend, GitRemote } from './backend.js';
import { GitError, SyncError } from './errors.js';
import { chooseBase, mergeHistories, mergeMessage } from './merge.js';
import { commitSubject, messageProblem, type PathChange } from './messages.js';
import {
	type Author,
	type CommitSummary,
	commitParents,
	commitTree,
	countOnly,
	diffFileMaps,
	EMPTY_TREE,
	hashFiles,
	isAncestor,
	readBlob,
	readTreeFiles,
	type TreeFile,
	writeCommitObject,
	writeFilesTree,
} from './objects.js';
import { createPassRunner } from './runner.js';
import { localMatcher, sourceFiles } from './scope.js';
import type { SyncOptions, SyncOutcome } from './sync.js';

export { GitError };

export type CommitOutcome =
	| {
			readonly status: 'committed';
			readonly oid: string;
			readonly parent: string | undefined;
			readonly message: string;
			readonly changedPaths: number;
			/** The branch moved, but the index could not be updated to match. */
			readonly indexWarning: string | undefined;
	  }
	| {
			readonly status: 'unchanged';
			readonly head: string | undefined;
			/** Index entries could not be reset to the head; the next pass retries. */
			readonly indexWarning: string | undefined;
	  }
	| {
			readonly status: 'branchMoved';
			readonly candidate: string;
			readonly expected: string | undefined;
			readonly actual: string | undefined;
	  }
	| { readonly status: 'blocked'; readonly reason: string }
	| { readonly status: 'failed'; readonly error: string }
	/** The host did not acknowledge the operation; inspect history before retrying. */
	| { readonly status: 'unconfirmed'; readonly error: string }
	| { readonly status: 'closed' };

/** What Sync's push of one commit did. */
export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string };

export type Observation<T> =
	| { readonly state: 'unknown'; readonly error: string | undefined }
	| {
			readonly state: 'observed';
			readonly value: T;
			readonly checkedAt: number;
			/** A known change happened after this observation was captured. */
			readonly stale: boolean;
			/** The latest attempt to refresh failed; `value` is the prior observation. */
			readonly error: string | undefined;
	  };

export type FilesObservation = {
	readonly head: string | undefined;
	/** Portable files that differ from the committed tree. */
	readonly changes: readonly PathChange[];
};

export type SyncObservation = {
	readonly head: string | undefined;
	/** The remote branch head as last recorded by a fetch or push. */
	readonly remote: string | undefined;
	readonly ahead: number;
	readonly behind: number;
};

export type Activity = { readonly active: boolean };

export type Attempt<T> = T & { readonly at: number };

export type GitSnapshot = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	readonly files: Observation<FilesObservation>;
	readonly sync: Observation<SyncObservation>;
	readonly activity: {
		readonly scan: Activity;
		readonly commit: Activity;
		readonly push: Activity;
		readonly fetch: Activity;
	};
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
	readonly closed: boolean;
};

/** A folder's history: what changed, the versions, and saving one. */
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
 */
export type FolderSync = {
	/**
	 * Commit saved files, fetch the remote branch, and bring the two
	 * together: a fast-forward, a push, or one merge commit of both heads,
	 * pushed before its files are written here. Units only one side changed
	 * merge; where both changed one, this device's side wins, and the merge
	 * commit names what lost. A delete never erases an edit it did not see.
	 */
	run(options?: SyncOptions): Promise<Result<SyncOutcome, SyncError>>;
	/**
	 * Make `url` the folder's remote (`remote.origin.url` in its Git
	 * configuration), then sync. An empty folder takes the remote's history; a
	 * folder with files and no history of its own merges them with it; a
	 * remote with no branch receives this folder's. Separate histories are
	 * `Unrelated` until `allowUnrelatedHistories` combines them. The remote
	 * stays set whatever the sync answers.
	 */
	connect(
		url: string,
		options?: SyncOptions,
	): Promise<Result<SyncOutcome, SyncError>>;
};

/**
 * One directory's history, as the `epicenter` CLI runs it (`runHistory` in
 * `bun.ts`): no `Folder` holds it (ADR-0636).
 */
export type FolderHistory = FolderGit & {
	readonly sync: FolderSync;
	/** The files changed outside the history; its observations are stale. */
	noteEdit(): void;
	close(): Promise<void>;
};

export function createHistory({
	backend,
	boundary,
	author,
	local,
	landed = () => {},
}: {
	backend: GitBackend;
	boundary: LockingStorage;
	author: Author;
	/**
	 * The `local` patterns the folder's `epicenter.json` listed as this
	 * history opened (`readLocalPolicy`). Given, the file must stay: a commit
	 * or publish that finds it gone is blocked. Without it, as for a history
	 * no policy was read for, a missing file adds nothing local.
	 */
	local?: readonly string[];
	/** Paths a Sync wrote or removed, whether or not it completed. */
	landed?: (paths: readonly string[]) => void;
}): FolderHistory {
	let clock = 0;
	let lastEdit = 0;
	/**
	 * Aborted when closing starts. From then on nothing new is admitted, and a
	 * request still waiting for the backend's protection is refused instead of
	 * running after the folder closed. Work already inside the protection is
	 * not interrupted.
	 */
	const closing = new AbortController();
	/** Commits of this handle that are waiting or running, and pushes running. */
	const running = { commit: 0, push: 0 };
	/** The backend's protection, waited for unless closing gets there first. */
	const exclusive = <T>(work: () => Promise<T>) =>
		backend.exclusive(work, closing.signal);
	let closed: Promise<void> | undefined;
	let files: Observation<FilesObservation> & { capturedAt?: number } = {
		state: 'unknown',
		error: undefined,
	};
	let sync: Observation<SyncObservation> = {
		state: 'unknown',
		error: undefined,
	};
	let lastCommit: GitSnapshot['lastCommit'];
	let lastPush: GitSnapshot['lastPush'];
	/** Git work of this handle, other than runner passes, that close waits for. */
	const admittedWork = new Set<Promise<unknown>>();
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	let snapshot: GitSnapshot;

	function emit() {
		const { capturedAt: _capturedAt, ...publicFiles } = files;
		snapshot = Object.freeze({
			branch: backend.branch,
			remote: backend.remote,
			files: publicFiles,
			sync,
			activity: {
				scan: { active: scanRunner.active },
				commit: { active: running.commit > 0 },
				push: { active: running.push > 0 },
				fetch: { active: fetchRunner.active },
			},
			lastCommit,
			lastPush,
			closed: closing.signal.aborted,
		});
		// A snapshot is published from inside saves and passes. A subscriber
		// that throws must not fail the save that changed the snapshot.
		for (const listener of [...listeners])
			if (listeners.has(listener))
				callObserver('history subscriber', listener, snapshot);
	}

	/** Record files observed at `capturedAt` unless a newer observation exists. */
	function observeFiles(capturedAt: number, value: FilesObservation) {
		if (files.state === 'observed' && (files.capturedAt ?? 0) > capturedAt)
			return;
		files = {
			state: 'observed',
			value,
			checkedAt: Date.now(),
			stale: lastEdit > capturedAt,
			error: undefined,
			capturedAt,
		};
	}

	function failFiles(error: string) {
		files =
			files.state === 'observed'
				? { ...files, stale: true, error }
				: { state: 'unknown', error };
	}

	async function headFiles(head: string | undefined) {
		if (head === undefined)
			return new Map<string, { oid: string; mode: string }>();
		return backend.withObjects(async (access) =>
			readTreeFiles(access, await commitTree(access, head)),
		);
	}

	/** `head`, when given, is the branch head the caller just read. */
	async function refreshSync(known?: { head: string | undefined }) {
		try {
			// Another page or program may have set the remote.
			await backend.refreshRemote();
			const [head, remote] = await Promise.all([
				known === undefined ? backend.readBranch() : known.head,
				backend.readRemoteTracking(),
			]);
			const [ahead, behind] = await backend.withObjects((access) =>
				Promise.all([
					countOnly(access, head, remote),
					countOnly(access, remote, head),
				]),
			);
			sync = {
				state: 'observed',
				value: { head, remote, ahead, behind },
				checkedAt: Date.now(),
				stale: false,
				error: undefined,
			};
		} catch (cause) {
			const error = describe(cause);
			sync =
				sync.state === 'observed'
					? { ...sync, stale: true, error }
					: { state: 'unknown', error };
		}
	}

	/**
	 * Every portable file's bytes, read now, for a commit or a status. A file
	 * removed while it is read is left out, as if the listing had missed it;
	 * a file that cannot be read throws, naming it.
	 */
	async function capture() {
		const { data: listed, error } = await boundary.list();
		if (error !== null) throw new Error(error.message);
		const files = new Map<string, Uint8Array>();
		const unreadable: string[] = [];
		for (const { path } of listed.files) {
			if (!isPortablePath(path)) continue;
			const read = await boundary.read(path);
			if (read.error === null) files.set(path, read.data.bytes);
			else if (read.error.name !== 'NotFound') unreadable.push(path);
		}
		if (unreadable.length > 0)
			throw new Error(
				`${unreadable.length} files could not be read: ${unreadable.join(', ')}`,
			);
		return files;
	}

	type IsLocal = (path: string) => boolean;

	/**
	 * Every `local` pattern this history has seen: the policy it opened with,
	 * and each one read since, from the folder or from a tree Sync brings in.
	 * It only grows, so a rule removed while an operation runs cannot expose
	 * a file the rule kept local.
	 */
	const localSeen = new Set(local);

	/** Every pattern seen, after taking in `patterns`. */
	function keep(patterns: readonly string[]): IsLocal {
		for (const pattern of patterns) localSeen.add(pattern);
		return localMatcher([...localSeen]);
	}

	/**
	 * The folder's own `local` policy, from its `epicenter.json` as `parsed`
	 * read it, `undefined` when there was none. A file that cannot be used is
	 * the reason, since a commit made without it could carry those files,
	 * and so is one removed since the history opened with it.
	 */
	function ownPolicy(
		parsed: Result<readonly string[] | undefined, { readonly reason: string }>,
	): Result<readonly string[], string> {
		if (parsed.error !== null)
			return Err(
				`${DEFINITION_PATH} cannot be used: ${parsed.error.reason}; fix the file before recording`,
			);
		if (parsed.data !== undefined) return Ok(parsed.data);
		if (local === undefined) return Ok([]);
		return Err(
			`${DEFINITION_PATH} was removed, so nothing says which files stay on this computer; restore it before recording`,
		);
	}

	/** The `local` policy of the folder's `epicenter.json` as it is now. */
	async function livePolicy(): Promise<Result<readonly string[], string>> {
		return ownPolicy(await readLocalPolicy(boundary));
	}

	/**
	 * The `local` policy of the `epicenter.json` in `captured`, the files a
	 * commit records: the commit's own file says what it leaves out.
	 */
	function capturedPolicy(
		captured: ReadonlyMap<string, Uint8Array>,
	): Result<readonly string[], string> {
		const bytes = captured.get(DEFINITION_PATH);
		return ownPolicy(
			bytes === undefined ? Ok(undefined) : parseLocalPolicy(bytes),
		);
	}

	/**
	 * The `local` patterns `commit`'s own `epicenter.json` lists, `undefined`
	 * when it has none.
	 */
	async function committedPolicy(
		commit: string | undefined,
	): Promise<Result<readonly string[] | undefined, string>> {
		const bytes = await blobOf((await headFiles(commit)).get(DEFINITION_PATH));
		if (bytes === null) return Ok(undefined);
		const { data: patterns, error } = parseLocalPolicy(bytes);
		if (error !== null)
			return Err(
				`${DEFINITION_PATH} in commit ${commit} cannot be used: ${error.reason}`,
			);
		return Ok(patterns);
	}

	/**
	 * The `local` patterns `to`'s `epicenter.json` lists that `since`'s does
	 * not: the rules a tree Sync brings here newly declares. A `since` whose
	 * file cannot be used counts as listing none, so all of `to`'s are new.
	 */
	async function addedPolicy(
		to: string,
		since: string | undefined,
	): Promise<Result<readonly string[], string>> {
		const after = await committedPolicy(to);
		if (after.error !== null) return after;
		const before = (await committedPolicy(since)).data ?? [];
		return Ok(
			(after.data ?? []).filter((pattern) => !before.includes(pattern)),
		);
	}

	/**
	 * Files kept on this machine now (ADR-0577; ADR-0592 later moves them to
	 * `.gitignore`): every pattern seen, after reading the folder's
	 * `epicenter.json` again and taking in `incoming`, the rules a tree Sync
	 * is about to merge or write newly declares. No commit carries one,
	 * whether or not `.gitignore` names it.
	 */
	async function localNow(
		incoming: readonly string[] = [],
	): Promise<Result<IsLocal, string>> {
		const { data: own, error } = await livePolicy();
		if (error !== null) return Err(error);
		return Ok(keep([...own, ...incoming]));
	}

	/**
	 * Why Sync may not leave this folder's `epicenter.json` keeping `after`,
	 * `undefined` for no file, or `undefined` when it may. Only a person here
	 * removes a rule from this folder: one `own`, the folder's file, lists
	 * that `after` omits stops Sync, as does one of `added`, which the
	 * remote's file newly declares. `before`, the rules of the branch's file,
	 * says which of `own` the remote removed and which no commit holds yet.
	 * A history opened with a policy (`local`) needs the file, so an `after`
	 * with none stops Sync too. `stopped` says what Sync left as it was.
	 */
	function dropsRules(
		after: readonly string[] | undefined,
		{
			own,
			before,
			added,
			stopped,
		}: {
			readonly own: readonly string[];
			readonly before: readonly string[];
			readonly added: readonly string[];
			readonly stopped: string;
		},
	): string | undefined {
		if (after === undefined && local !== undefined)
			return `the remote removed ${DEFINITION_PATH}, which says which files stay on this computer and which this folder needs to record anything, ${stopped}. Restore ${DEFINITION_PATH} on the remote from the device that removed it, then sync again`;
		const omitted = (patterns: readonly string[]) =>
			patterns.filter((pattern) => !(after ?? []).includes(pattern));
		const listed = (patterns: readonly string[]) =>
			patterns.map((pattern) => `'${pattern}'`).join(', ');
		const dropped = omitted(own.filter((pattern) => before.includes(pattern)));
		if (dropped.length > 0)
			return `the remote's ${DEFINITION_PATH} no longer keeps ${listed(dropped)} on each computer, but this folder's does, ${stopped}. To share those files, remove ${listed(dropped)} from "local" in this folder's ${DEFINITION_PATH}; to keep them local, restore ${listed(dropped)} in the remote's ${DEFINITION_PATH} from the device that removed it; then sync again`;
		const lost = omitted(added);
		if (lost.length > 0)
			return `merging would drop ${listed(lost)} from "local", which the remote's ${DEFINITION_PATH} newly keeps on each computer, ${stopped}. Add ${listed(lost)} to "local" in this folder's ${DEFINITION_PATH}, then sync again`;
		const unrecorded = omitted(
			own.filter((pattern) => !before.includes(pattern)),
		);
		if (unrecorded.length > 0)
			return `merging would drop ${listed(unrecorded)} from "local", which this folder's ${DEFINITION_PATH} lists and no commit holds yet, ${stopped}. Sync again, which records it first`;
		return undefined;
	}

	/**
	 * Why Sync may not bring `to`, a commit it is about to send or publish,
	 * over the folder, whose branch is at `from`, or `undefined`: `to`'s
	 * `epicenter.json` drops a rule (`dropsRules`). Of the folder's own rules
	 * only those `from` records count: one added since is a person's edit no
	 * commit holds, which the publish keeps over `to`'s file.
	 */
	async function weakened(
		to: string,
		{
			from,
			added = [],
		}: {
			readonly from: string | undefined;
			readonly added?: readonly string[];
		},
	): Promise<string | undefined> {
		const own = await livePolicy();
		if (own.error !== null) return own.error;
		const after = await committedPolicy(to);
		if (after.error !== null) return after.error;
		// A `from` whose file cannot be used held every rule the folder's does.
		const prior = await committedPolicy(from);
		const before = prior.error === null ? (prior.data ?? []) : own.data;
		return dropsRules(after.data, {
			own: own.data.filter((pattern) => before.includes(pattern)),
			before,
			added,
			stopped: 'so Sync changed and sent nothing',
		});
	}

	/** The rules a publish keeps: `before`, the branch's, and `added`, `to`'s new ones. */
	type PublishRules = {
		readonly before: readonly string[];
		readonly added: readonly string[];
	};

	/**
	 * Why a publish may not leave `result` as the folder's `epicenter.json`
	 * where it holds `live`, or `undefined`: `result` drops a rule `live`
	 * lists or `added` declares (`dropsRules`), or cannot be used.
	 */
	function replacesPolicy(
		live: Uint8Array | null,
		result: Uint8Array | null,
		{ before, added }: PublishRules,
	): string | undefined {
		const stopped = "so Sync left this folder's files as they were";
		const own = ownPolicy(
			live === null ? Ok(undefined) : parseLocalPolicy(live),
		);
		if (own.error !== null) return own.error;
		if (result === null)
			return dropsRules(undefined, { own: own.data, before, added, stopped });
		const after = parseLocalPolicy(result);
		if (after.error !== null)
			return `merging this folder's ${DEFINITION_PATH} with the remote's would leave it unusable (${after.error.reason}), ${stopped}. Make this folder's ${DEFINITION_PATH} hold the remote's changes as well as its own, then sync again`;
		return dropsRules(after.data, { own: own.data, before, added, stopped });
	}

	/**
	 * Publish `to`'s `epicenter.json`, `next`, over the folder's through
	 * `held`, as every file is (`publishFile`), unless `replacesPolicy`
	 * refuses it first. Each attempt of the one write reads the live file,
	 * merges, and puts guarded by the hash it read, so what is checked is
	 * the very bytes that land over the very file read; a merge that leaves
	 * the live file as it is is checked as well.
	 */
	async function publishPolicy(
		held: FolderStorage,
		{
			was,
			next,
			...rules
		}: PublishRules & {
			readonly was: Uint8Array | null;
			readonly next: Uint8Array | null;
		},
	) {
		const check = (live: Uint8Array | null, result: Uint8Array | null) =>
			replacesPolicy(live, result, rules);
		// The attempt in progress: the live bytes it read, and whether it put.
		const attempt = {
			live: null as Uint8Array | null,
			put: false,
			refused: undefined as string | undefined,
		};
		const written = await publishFile(
			{
				async read(path) {
					const read = await held.read(path);
					attempt.live = read.error === null ? read.data.bytes : null;
					attempt.put = false;
					return read;
				},
				async put(path, bytes, ifMatch) {
					attempt.put = true;
					attempt.refused = check(attempt.live, bytes);
					if (attempt.refused !== undefined)
						return FileError.Io({
							path,
							operation: 'write',
							cause: new Error(attempt.refused),
						});
					return held.put(path, bytes, ifMatch);
				},
			},
			DEFINITION_PATH,
			was,
			next,
		);
		if (written.error === null && !attempt.put)
			attempt.refused = check(attempt.live, attempt.live);
		return { written, refused: attempt.refused };
	}

	/**
	 * Why `oid` may not be sent to a remote whose branch is at `remote`, or
	 * `undefined`: a commit the remote would newly hold adds or changes a
	 * path a pattern this history has seen keeps local. The remote receives
	 * every commit before `oid`, so a clean latest tree is not enough. Sync
	 * never rewrites history to remove it.
	 */
	async function carriesLocal(
		oid: string,
		remote: string | undefined,
	): Promise<string | undefined> {
		if (localSeen.size === 0) return undefined;
		const isLocal = localMatcher([...localSeen]);
		return backend.withObjects(async (access) => {
			const filesOf = async (commit: string) =>
				readTreeFiles(access, await commitTree(access, commit));
			const held = new Set<string>();
			const below = remote === undefined ? [] : [remote];
			while (below.length > 0) {
				const commit = below.pop()!;
				if (held.has(commit)) continue;
				held.add(commit);
				try {
					below.push(...(await commitParents(access, commit)));
				} catch {
					// Missing history beyond a shallow boundary ends the walk.
				}
			}
			const sent = new Set<string>();
			const unsent = [oid];
			while (unsent.length > 0) {
				const commit = unsent.pop()!;
				if (sent.has(commit) || held.has(commit)) continue;
				sent.add(commit);
				const parents = await commitParents(access, commit);
				unsent.push(...parents);
				const before = await Promise.all(parents.map(filesOf));
				for (const [path, entry] of await filesOf(commit)) {
					if (!isLocal(path)) continue;
					if (before.some((files) => files.get(path)?.oid === entry.oid))
						continue;
					const verb = before.some((files) => files.has(path))
						? 'changes'
						: 'adds';
					return `commit ${commit} ${verb} '${path}', which ${DEFINITION_PATH} keeps on this computer, and the remote does not hold that commit yet, so Sync sent nothing. Remove '${path}' from the commits the remote does not have with Git (Sync never rewrites history), then sync again`;
				}
			}
			return undefined;
		});
	}

	/**
	 * Why `commit` may not be sent, or `undefined`: it carries a path its own
	 * `epicenter.json` keeps local, which a merge does only when its merged
	 * file lists a rule the merge was not made with.
	 */
	async function keptByItsOwn(commit: string): Promise<string | undefined> {
		const { data: patterns, error } = await committedPolicy(commit);
		if (error !== null) return error;
		const isLocal = localMatcher(patterns);
		const path = [...(await headFiles(commit)).keys()].find(isLocal);
		if (path === undefined) return undefined;
		return `the merge with the remote carries '${path}', which its own ${DEFINITION_PATH} keeps local, so Sync changed and sent nothing. Make "local" in this folder's ${DEFINITION_PATH} list every rule the remote's does, then sync again`;
	}

	/** Captured files that are history source under the shared scope rule. */
	function source(
		current: ReadonlyMap<string, Uint8Array>,
		tracked: ReadonlyMap<string, unknown>,
		isLocal: IsLocal,
	) {
		return sourceFiles(current, tracked, backend.ignoredPaths, isLocal);
	}

	/**
	 * Record a clean observation only if the branch still names `head`;
	 * otherwise invalidate and start a real scan if none is running. The branch
	 * already moved when this runs, so a branch that cannot be read back is an
	 * observation failure, never a reason to report the commit as failed.
	 */
	async function observeCommitted(
		capturedAt: number,
		head: string | undefined,
	) {
		let actual: string | undefined;
		try {
			actual = await backend.readBranch();
		} catch (cause) {
			failFiles(describe(cause));
			return;
		}
		if (actual === head) {
			observeFiles(capturedAt, { head, changes: [] });
			return;
		}
		if (files.state === 'observed') files = { ...files, stale: true };
		void scanRunner.attempt();
	}

	/** A known file change: existing observations become stale. */
	function markEdited() {
		lastEdit = ++clock;
		if (files.state === 'observed' && !files.stale)
			files = { ...files, stale: true };
	}

	/**
	 * Sync wrote files. The cached observation no longer describes the
	 * folder: mark it stale and start a fresh scan if none is running. Only
	 * `kept`, a file whose edit since the commit Sync merged into it rather
	 * than replaced, is an edit the new head does not hold. This requests no
	 * commit.
	 */
	function markLanded(kept: boolean) {
		if (kept) markEdited();
		else if (files.state === 'observed' && !files.stale)
			files = { ...files, stale: true };
		void scanRunner.attempt();
	}

	const scanRunner = createPassRunner<Result<FilesObservation, GitError>>({
		async run() {
			const capturedAt = ++clock;
			try {
				const captured = await capture();
				const head = await backend.readBranch();
				const committed = await headFiles(head);
				// Status shows what a commit would record; with an
				// `epicenter.json` that cannot be used, by every pattern seen.
				const isLocal = keep(capturedPolicy(captured).data ?? []);
				const hashes = await hashFiles(
					await source(captured, committed, isLocal),
				);
				const value: FilesObservation = {
					head,
					changes: diffFileMaps(committed, hashes),
				};
				observeFiles(capturedAt, value);
				await refreshSync({ head });
				emit();
				return Ok(value);
			} catch (cause) {
				failFiles(describe(cause));
				emit();
				return GitError.Failed({ operation: 'status', cause });
			}
		},
		failed: (cause) => GitError.Failed({ operation: 'status', cause }),
		closed: () => GitError.Closed(),
		onChange: () => emit(),
	});

	/**
	 * One whole-folder commit, after waiting for the backend's protection. A
	 * branch that moved under the first attempt is met by one more, from a
	 * fresh capture over the new head (ADR-0541): the files are still on
	 * disk, so it records everything the lost attempt held. A second move is
	 * reported.
	 */
	function commitCurrentFiles(
		onCapture?: (capturedAt: number) => void,
		subject?: string,
	): Promise<CommitOutcome> {
		return exclusive(async (): Promise<CommitOutcome> => {
			const first = await attemptCommit(onCapture, subject);
			if (first.status !== 'branchMoved') return first;
			return attemptCommit(onCapture, subject);
		});
	}

	/**
	 * One attempt at a whole-folder commit, inside the backend's protection.
	 * `subject` is the message a person gave; without it the message names
	 * what changed.
	 */
	async function attemptCommit(
		onCapture?: (capturedAt: number) => void,
		subject?: string,
	): Promise<CommitOutcome> {
		// A folder whose repository its first commit creates gets it here.
		const unborn = await backend.createRepository?.();
		if (unborn !== undefined) return { status: 'blocked', reason: unborn };
		const blocked = await backend.blocked();
		if (blocked !== undefined) return { status: 'blocked', reason: blocked };
		const unfinished = await finishPublishing();
		if (unfinished !== undefined)
			return { status: 'blocked', reason: unfinished };
		// Pin the parent, then capture, both inside the backend's
		// protection. A publish of this handle that changed files and the
		// branch while this pass waited is part of the capture, so an older
		// capture can never be committed on top of a newer parent. A branch
		// move from outside the protection after this point fails the
		// compare-and-swap below.
		const parent = await backend.readBranch();
		const capturedAt = ++clock;
		onCapture?.(capturedAt);
		const current = await capture();
		// What stays local is read from the `epicenter.json` bytes this
		// commit records, never from an earlier read the file may have
		// changed since: the commit leaves out every path its own file keeps.
		const { data: policy, error: localProblem } = capturedPolicy(current);
		if (localProblem !== null)
			return { status: 'blocked', reason: localProblem };
		const isLocal = keep(policy);
		const committed = await headFiles(parent);
		const included = await source(current, committed, isLocal);
		// An empty folder with no history has nothing to record, and writes
		// nothing: not even an empty tree.
		const built =
			parent === undefined && included.size === 0
				? undefined
				: await backend.withObjects(async (access) => {
						const tree = await writeFilesTree(access, included, committed);
						const parentTree =
							parent === undefined
								? EMPTY_TREE
								: await commitTree(access, parent);
						if (tree === parentTree) return undefined;
						const changes = diffFileMaps(
							committed,
							await readTreeFiles(access, tree),
						);
						const message = subject ?? commitSubject(changes);
						if (message === undefined) return undefined;
						const oid = await writeCommitObject(access, {
							tree,
							parents: parent === undefined ? [] : [parent],
							message,
							author,
						});
						return { oid, message, changes };
					});
		if (built !== undefined) {
			const moved = await backend.casBranch(parent, built.oid);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					candidate: built.oid,
					expected: parent,
					actual: moved.actual,
				};
		}
		const head = built?.oid ?? parent;
		// A whole-folder checkpoint supersedes staged-only intent: every index
		// entry, including staged-only additions and deletions, is reset to
		// the head. This also repairs staging when nothing new was committed.
		let indexWarning: string | undefined;
		if (head !== undefined)
			try {
				await backend.reconcileIndex(head);
			} catch (cause) {
				indexWarning = describe(cause);
			}
		await observeCommitted(capturedAt, head);
		if (built === undefined)
			return { status: 'unchanged', head: parent, indexWarning };
		return {
			status: 'committed',
			oid: built.oid,
			parent,
			message: built.message,
			changedPaths: built.changes.length,
			indexWarning,
		};
	}

	/** Whether `cause` is closing refusing a request that was still waiting. */
	const refusedByClose = (cause: unknown) =>
		closing.signal.aborted && cause === closing.signal.reason;

	/**
	 * A commit that threw. A private write whose outcome is unknown, such as
	 * a branch ref whose stream failed to close, may have landed: that commit
	 * is `unconfirmed`, never `failed`.
	 */
	const failedCommit = (cause: unknown): CommitOutcome =>
		cause instanceof UnconfirmedWrite
			? { status: 'unconfirmed', error: describe(cause) }
			: { status: 'failed', error: describe(cause) };

	/** Record what a commit that ran did and what is now known of the remote. */
	async function settleCommit(outcome: CommitOutcome) {
		lastCommit = { ...outcome, at: Date.now() };
		await refreshSync();
		emit();
	}

	/**
	 * An explicit commit. It waits for the backend's protection and captures
	 * inside it. Closing refuses it while it still waits; once inside, it runs
	 * to its end and reports what it did. It counts as active from the moment
	 * it is asked for, including that wait, and `close()` waits for it.
	 */
	function commitNow(
		onCapture?: (capturedAt: number) => void,
		subject?: string,
	): Promise<CommitOutcome> {
		if (closing.signal.aborted) return Promise.resolve({ status: 'closed' });
		if (subject !== undefined) {
			const problem = messageProblem(subject);
			if (problem !== undefined)
				return Promise.resolve({ status: 'failed', error: problem });
		}
		// Registered before the commit starts: the commit, or an observer it
		// notifies, can close this handle synchronously.
		running.commit++;
		const completion = Promise.withResolvers<CommitOutcome>();
		const settled = completion.promise.finally(() => {
			running.commit--;
			admittedWork.delete(settled);
			emit();
		});
		admittedWork.add(settled);
		void (async (): Promise<CommitOutcome> => {
			let outcome: CommitOutcome;
			try {
				outcome = await commitCurrentFiles(onCapture, subject);
			} catch (cause) {
				// Refused while waiting: nothing ran, so no attempt is recorded.
				if (refusedByClose(cause)) return { status: 'closed' };
				outcome = failedCommit(cause);
			}
			await settleCommit(outcome);
			return outcome;
		})().then(completion.resolve, completion.reject);
		emit();
		return settled;
	}

	/**
	 * Sync's fetches, one at a time: the remote branch head, or `undefined`
	 * when the remote has no such branch.
	 */
	const fetchRunner = createPassRunner<Result<string | undefined, GitError>>({
		async run(signal) {
			if ((await backend.refreshRemote()) === undefined)
				return GitError.NoRemote();
			let result: Result<string | undefined, GitError>;
			try {
				result = Ok(await backend.fetch(signal));
			} catch (cause) {
				result = GitError.Failed({ operation: 'fetch', cause });
			}
			await refreshSync();
			emit();
			return result;
		},
		failed: (cause) => GitError.Failed({ operation: 'fetch', cause }),
		closed: () => GitError.Closed(),
		onChange: () => emit(),
	});

	/**
	 * Refuse a tree, the files of `commit`, that a folder cannot write as
	 * plain bytes: a link, an executable, a submodule, an invalid path, a Git
	 * attribute filter, or two paths only their case tells apart. `whose` is
	 * the remote's tree arriving, or this folder's about to be sent.
	 */
	async function representable(
		commit: string,
		whose: 'remote' | 'folder',
	): Promise<Result<undefined, SyncError>> {
		const files = await headFiles(commit);
		const unsupported = [...files]
			.filter(([, entry]) => entry.mode !== '100644')
			.map(([path]) => path);
		if (unsupported.length > 0)
			return SyncError.Unrepresentable({
				whose,
				paths: unsupported,
				reason:
					'symbolic links, submodules, and executable files are not plain folder files',
			});
		const invalid = [...files.keys()].filter(
			(path) => pathProblem(path) !== undefined,
		);
		if (invalid.length > 0)
			return SyncError.Unrepresentable({
				whose,
				paths: invalid,
				reason: 'some paths are not valid folder paths',
			});
		// Under a filter a blob means something else than its bytes: under
		// `filter=lfs` it is a pointer.
		const attributeFiles = await backend.withObjects((access) =>
			Promise.all(
				[...files]
					.filter(([path]) => isAttributesPath(path))
					.map(
						async ([path, entry]) =>
							[path, await readBlob(access, entry.oid)] as const,
					),
			),
		);
		const filter = declaredFilter(attributeFiles);
		if (filter !== undefined)
			return SyncError.Unrepresentable({
				whose,
				paths: [filter.path],
				reason: `${filter.path} line ${filter.line} (${filter.text}) names a Git filter, and this folder writes every file as plain bytes`,
			});
		// Every file and every directory on the way to one, so `Docs/a.md`
		// and `docs/b.md` collide as surely as `a.md` and `A.md` do.
		const folded = new Map<string, string>();
		for (const path of files.keys())
			for (const name of [...ancestors(path), path]) {
				const key = collisionKey(name);
				const existing = folded.get(key);
				if (existing !== undefined && existing !== name)
					return SyncError.Unrepresentable({
						whose,
						paths: [existing, name],
						reason: 'paths collide on case-insensitive filesystems',
					});
				folded.set(key, name);
			}
		return Ok(undefined);
	}

	/**
	 * The files `from` and `to` hold, and the paths Sync changes between
	 * them, local paths aside (ADR-0577).
	 */
	async function between(
		from: string | undefined,
		to: string,
		isLocal: IsLocal,
	) {
		const [before, after] = await Promise.all([headFiles(from), headFiles(to)]);
		const changes = diffFileMaps(before, after).filter(
			(change) => !isLocal(change.path),
		);
		return { before, after, changes };
	}
	type Between = Awaited<ReturnType<typeof between>>;

	const blobOf = (entry: TreeFile | undefined) =>
		entry === undefined
			? Promise.resolve(null)
			: backend.withObjects((access) => readBlob(access, entry.oid));

	/**
	 * What in `storage`, as it is now, stands where the files of `to` go.
	 * `occupied`: a file of this folder where `to` needs a directory, files
	 * where it needs a file, a name held under another spelling, or a file
	 * where `to` adds one that cannot be read.
	 * `untracked`: a file `from` never tracked (ignored, or made since) where
	 * `to` adds different bytes, which Sync never merges into history on its
	 * own. `failed` when the folder cannot be listed.
	 */
	async function inTheWay(
		storage: Pick<FolderStorage, 'list' | 'read'>,
		{ before, after, changes }: Between,
	): Promise<{
		readonly occupied: readonly string[];
		readonly untracked: readonly string[];
		readonly failed?: string;
	}> {
		const { data: listed, error } = await storage.list();
		if (error !== null)
			return { occupied: [], untracked: [], failed: error.message };
		const leaving = new Set(
			changes
				.filter((change) => change.kind === 'delete')
				.map((change) => change.path),
		);
		const staying = listed.files
			.map(({ path }) => path)
			.filter((path) => !leaving.has(path));
		const present = new Set(staying);
		// On a case-insensitive disk a name is taken by every spelling of it,
		// so names are compared folded (`collisionKey`).
		const files = new Map(staying.map((path) => [collisionKey(path), path]));
		const directories = new Map<string, string>();
		for (const path of staying)
			for (const directory of ancestors(path))
				directories.set(collisionKey(directory), directory);
		const occupied = changes
			.filter((change) => change.kind !== 'delete')
			.map((change) => change.path)
			.filter((path) => {
				const key = collisionKey(path);
				const spelled = files.get(key);
				return (
					(spelled !== undefined && spelled !== path) ||
					directories.has(key) ||
					ancestors(path).some((ancestor) => {
						const folded = collisionKey(ancestor);
						const directory = directories.get(folded);
						return (
							files.has(folded) ||
							(directory !== undefined && directory !== ancestor)
						);
					})
				);
			});
		const untracked: string[] = [];
		for (const { path } of changes) {
			if (before.has(path) || !after.has(path) || !present.has(path)) continue;
			const read = await storage.read(path);
			// A file that cannot be read is no file to record: Sync stops.
			if (read.error !== null) occupied.push(path);
			else if (!sameContent(read.data.bytes, await blobOf(after.get(path))))
				untracked.push(path);
		}
		return { occupied, untracked };
	}

	/**
	 * Of files `from` never tracked where `to` adds other bytes, the ones the
	 * person made, which Sync records and merges, and the ignored ones, which
	 * Sync never takes into history and stops for.
	 */
	async function madeHere(untracked: readonly string[]) {
		if (untracked.length === 0) return { made: [], ignored: [] };
		const ignored = await backend.ignoredPaths(untracked, await capture());
		return {
			made: untracked.filter((path) => !ignored.has(path)),
			ignored: untracked.filter((path) => ignored.has(path)),
		};
	}

	/** Why Sync stops for what stands in the way, or `undefined`. */
	function wayProblem(failed: string | undefined, paths: readonly string[]) {
		if (failed !== undefined) return failed;
		if (paths.length === 0) return undefined;
		return `files of this folder stand where the remote has ${paths.map((path) => `'${path}'`).join(', ')}; move them, then sync again`;
	}

	/**
	 * Mark the publish of `to` over the files the branch left at `from` as
	 * begun: `refs/epicenter/publishing` names a commit whose parents are
	 * `from`, when there is one, then `to`, which also keeps both from being
	 * collected while the publish is unfinished.
	 */
	async function beginPublishing(from: string | undefined, to: string) {
		const marker = await backend.withObjects(async (access) =>
			writeCommitObject(access, {
				tree: await commitTree(access, to),
				parents: from === undefined ? [to] : [from, to],
				message: 'Epicenter Sync is publishing this commit',
				author,
			}),
		);
		await backend.writePublishing(marker);
	}

	/**
	 * Inside the protection, before any commit records the files: finish a
	 * publish a Sync began and was cut off from (`refs/epicenter/publishing`).
	 * Its files hold `to`'s bytes or `from`'s, which a commit would otherwise
	 * record as this device's own edits, and a later merge would let them win
	 * over the other device's newer ones. While the branch is still at
	 * `from`, the same publish runs again: a file already at `to` stays, one
	 * still at `from` takes `to`, and one edited since keeps its edit. A
	 * branch that moved since leaves nothing to finish.
	 */
	async function finishPublishing(): Promise<string | undefined> {
		const marker = await backend.readPublishing();
		if (marker === undefined) return undefined;
		const parents = await backend.withObjects((access) =>
			commitParents(access, marker),
		);
		const [from, to] = parents.length === 2 ? parents : [undefined, parents[0]];
		if (to === undefined || (await backend.readBranch()) !== from) {
			await backend.writePublishing(undefined);
			return undefined;
		}
		const { error } = await publishWithin(from, to, { resuming: true });
		if (error === null) return undefined;
		return `a Sync stopped while it wrote this folder's files and cannot finish them: ${error.message}`;
	}

	/**
	 * Write the tree of `to` over the files, which the branch left at `from`,
	 * then move the branch and set the index to it.
	 */
	function publish(from: string | undefined, to: string) {
		return exclusive(() => publishWithin(from, to, { resuming: false }));
	}

	/**
	 * Inside the protection: write the tree of `to` over the files, which the
	 * branch left at `from`, then move the branch and set the index to it.
	 * `moved` when a commit moved the branch since `from`, so Sync merges from
	 * there instead.
	 *
	 * Each path that differs between the two goes once, by the one write
	 * (ADR-0576), `from`'s file the base, `to`'s the current file, and the
	 * live file the change: one still at `from`'s bytes takes `to`'s, and one
	 * edited since keeps the units it changed.
	 * Each file is checked and written holding the folder's save lock
	 * (`lock`), one file at a time, so no cooperating save lands between its
	 * check and its write, and a save waits for one file, never for the whole
	 * publish. Removals go first, in one hold of the lock: every one is
	 * checked against `from`'s bytes, then all are made, with the directories
	 * they empty after them, so a file can take a directory's place and the
	 * reverse; an empty directory where a file goes is removed too.
	 * The folder's `epicenter.json` is written or removed in that same hold,
	 * before every other file, and only as one that keeps every rule its live
	 * bytes list and every one `to`'s newly declares (`publishPolicy`), so a
	 * rule saved after Sync checked `to`, even after this publish began,
	 * survives or stops the publish before anything changed.
	 *
	 * `edited` when a file `to` removes holds an edit no commit has, answered
	 * before anything changed: Sync records it and merges again, and the
	 * edit stands, since a delete never erases an edit it did not see. Every
	 * write lands whole, so a publish that stops partway leaves each file at
	 * its old bytes or its new ones, and `refs/epicenter/publishing` says which
	 * publish they belong to until the branch moves: the next commit finishes
	 * it first (`finishPublishing`). `resuming` is that second run. The files
	 * hold part of `to` already, so recording an edit first would record that
	 * part as this device's: a file `to` removes that was edited after the cut
	 * stays, and a file the person made where `to` adds one, ignored aside,
	 * merges with `to`'s as an addition on both sides, the live file winning.
	 */
	async function publishWithin(
		from: string | undefined,
		to: string,
		{ resuming }: { readonly resuming: boolean },
	): Promise<
		Result<
			| { readonly kind: 'published' }
			| { readonly kind: 'edited' }
			| { readonly kind: 'moved'; readonly head: string | undefined },
			SyncError
		>
	> {
		const blocked = await backend.blocked();
		if (blocked !== undefined) return SyncError.Blocked({ reason: blocked });
		const head = await backend.readBranch();
		if (head !== from) return Ok({ kind: 'moved', head } as const);
		// What `to`'s own `epicenter.json` newly keeps local stays off the
		// files too, as a rule the folder already holds does.
		const added = await addedPolicy(to, from);
		if (added.error !== null) return SyncError.Blocked({ reason: added.error });
		const { data: isLocal, error: localProblem } = await localNow(added.data);
		if (localProblem !== null)
			return SyncError.Blocked({ reason: localProblem });
		// A `from` whose file cannot be used held every rule the folder's does.
		const prior = await committedPolicy(from);
		const before = prior.error === null ? (prior.data ?? []) : [...localSeen];
		const plan = await between(from, to, isLocal);
		const way = await inTheWay(boundary, plan);
		const { made, ignored } = await madeHere(way.untracked);
		const refused = wayProblem(way.failed, [...way.occupied, ...ignored]);
		if (refused !== undefined) return SyncError.Blocked({ reason: refused });
		// A file the person made where `to` adds one, which no commit holds:
		// recorded first, it merges with `to`'s as an addition on both sides.
		// Resuming, part of `to` is in the files already, so it joins `to`'s
		// here instead.
		if (made.length > 0 && !resuming) return Ok({ kind: 'edited' } as const);
		// Read from history before any lock: only each file's check and
		// write need it.
		const blobs = new Map<
			string,
			{ readonly was: Uint8Array | null; readonly next: Uint8Array | null }
		>();
		for (const { path } of plan.changes)
			blobs.set(path, {
				was: await blobOf(plan.before.get(path)),
				next: await blobOf(plan.after.get(path)),
			});
		const removals = plan.changes
			.filter((change) => change.kind === 'delete')
			.map(({ path }) => path);
		const writes = plan.changes
			.filter((change) => change.kind !== 'delete')
			.map(({ path }) => path);
		// A publish that changes no file has nothing to finish, and one
		// resuming is already named.
		const marked = resuming || plan.changes.length > 0;
		if (marked && !resuming) await beginPublishing(from, to);
		const unmark = () =>
			marked ? backend.writePublishing(undefined) : Promise.resolve();
		const { data: listed } = await boundary.list();
		const directories = listed?.directories ?? [];
		const reached: string[] = [];
		let kept = false;
		const failed = (path: string, error: { message: string }) =>
			SyncError.Publish({ path, error: error.message });
		try {
			const removed = await boundary.lock(
				async (
					held,
				): Promise<
					Result<'removed' | 'edited' | { refused: string }, SyncError>
				> => {
					const currentPolicy = ownPolicy(await readLocalPolicy(held));
					if (currentPolicy.error !== null)
						return SyncError.Blocked({ reason: currentPolicy.error });
					const currentLocal = keep(currentPolicy.data);
					const targets: { path: string; sha256: string }[] = [];
					for (const path of removals) {
						if (currentLocal(path)) continue;
						const read = await held.read(path);
						// No file there: gone already, or a directory a cut
						// publish made in its place.
						if (
							read.error?.name === 'NotFound' ||
							read.error?.name === 'NotAFile'
						)
							continue;
						if (read.error !== null) return failed(path, read.error);
						if (sameContent(read.data.bytes, blobs.get(path)!.was))
							targets.push({ path, sha256: read.data.sha256 });
						else if (resuming) kept = true;
						else return Ok('edited');
					}
					// A file `to` changes that was moved or removed since the
					// checkpoint is that change of the person's, which no commit
					// holds yet: recorded first, the merge keeps the incoming
					// edit at its path and names the removal it gave way to.
					if (!resuming)
						for (const path of writes) {
							if (blobs.get(path)!.was === null) continue;
							if ((await held.read(path)).error?.name === 'NotFound')
								return Ok('edited');
						}
					// The folder's `epicenter.json` goes first, in this same hold,
					// and only as one that keeps every rule its live bytes list
					// and every one `to`'s newly declares: refused, nothing
					// changed. A rule saved after this publish began is read here.
					const policy = blobs.get(DEFINITION_PATH);
					if (policy !== undefined) {
						const rules = { before, added: added.data };
						if (targets.some(({ path }) => path === DEFINITION_PATH)) {
							// Its live bytes are `from`'s, by the hash the removal
							// is guarded by.
							const refused = replacesPolicy(policy.was, null, rules);
							if (refused !== undefined) return Ok({ refused });
						} else if (writes.includes(DEFINITION_PATH)) {
							const { written, refused } = await publishPolicy(held, {
								...rules,
								...policy,
							});
							if (refused !== undefined) return Ok({ refused });
							if (written.error !== null)
								return failed(DEFINITION_PATH, written.error);
							if (!sameContent(written.data.file?.bytes ?? null, policy.next))
								kept = true;
							reached.push(DEFINITION_PATH);
						}
					}
					for (const { path, sha256 } of targets) {
						const put = await confirmedPut(held, path, null, sha256, null);
						if (put.error !== null) return failed(path, put.error);
						// Changed by a program outside the save lock: it stays.
						if (put.data === 'stale') {
							kept = true;
							continue;
						}
						reached.push(path);
						for (const directory of ancestors(path).reverse())
							if ((await held.rmdir(directory)).error !== null) break;
					}
					return Ok('removed');
				},
			);
			if (removed.error !== null) return Err(removed.error);
			if (removed.data === 'edited') {
				// Answered before anything changed.
				await unmark();
				return Ok({ kind: 'edited' } as const);
			}
			if (typeof removed.data === 'object') {
				// Refused before this run changed anything; a resumed publish
				// stays named, as its files may hold part of `to` already.
				if (!resuming) await unmark();
				return SyncError.Blocked({ reason: removed.data.refused });
			}
			for (const path of writes) {
				if (path === DEFINITION_PATH) continue;
				const { was, next } = blobs.get(path)!;
				const outcome = await boundary.lock(async (held) => {
					const currentPolicy = ownPolicy(await readLocalPolicy(held));
					if (currentPolicy.error !== null)
						return { kind: 'blocked', reason: currentPolicy.error } as const;
					if (keep(currentPolicy.data)(path))
						return { kind: 'skipped' } as const;
					// An empty directory where the file goes, which a removal
					// cut off before its own prune can leave.
					for (const directory of directories
						.filter(
							(directory) =>
								directory === path || directory.startsWith(`${path}/`),
						)
						.sort((a, b) => b.length - a.length))
						await held.rmdir(directory);
					// The live file is the change: an edit since the checkpoint,
					// or a file the person made where `to` adds one, stands.
					return {
						kind: 'wrote',
						result: await publishFile(held, path, was, next),
					} as const;
				});
				if (outcome.kind === 'blocked')
					return SyncError.Blocked({ reason: outcome.reason });
				if (outcome.kind === 'skipped') {
					kept = true;
					continue;
				}
				const { data: wrote, error } = outcome.result;
				// A file this folder cannot take there, from a program outside
				// the save lock or a name the disk holds under another spelling.
				if (error !== null) return failed(path, error);
				if (!sameContent(wrote.file?.bytes ?? null, next)) kept = true;
				reached.push(path);
			}
			const moved = await backend.casBranch(from, to);
			// Either way the files now belong to the branch as it is.
			await unmark();
			if (!moved.ok)
				return SyncError.Blocked({
					reason: `the branch moved to ${moved.actual ?? 'no commit'} while Sync wrote its files, which are now changes to it`,
				});
			// The branch holds the files now. An index another program holds
			// is left as it is, as a commit leaves it: the next commit
			// refreshes it.
			await backend.reconcileIndex(to).catch(() => {});
			return Ok({ kind: 'published' } as const);
		} finally {
			// Heard once the branch and the index are set, or the publish
			// stopped: a status taken between them would be of neither.
			if (reached.length > 0) {
				markLanded(kept);
				landed(reached);
			}
		}
	}

	/**
	 * Admit one sync call for its whole lifetime: refused once closing
	 * starts, and drained by `close()`. Each step it composes is admitted on
	 * its own as well.
	 */
	function syncing<T>(
		work: () => Promise<Result<T, SyncError>>,
	): Promise<Result<T, SyncError>> {
		if (closing.signal.aborted) return Promise.resolve(SyncError.Closed());
		const settled = work().catch(
			(cause): Result<T, SyncError> =>
				refusedByClose(cause)
					? SyncError.Closed()
					: SyncError.Failed({ cause }),
		);
		admittedWork.add(settled);
		void settled.then(() => admittedWork.delete(settled));
		return settled;
	}

	/** Push `oid`, never forcing: `rejected` when the remote moved on. */
	async function pushCommit(oid: string): Promise<PushOutcome | 'rejected'> {
		running.push++;
		emit();
		let outcome: PushOutcome | 'rejected';
		try {
			outcome =
				(await backend.push(oid, closing.signal)) === 'pushed'
					? { status: 'pushed', oid }
					: 'rejected';
		} catch (cause) {
			outcome = closing.signal.aborted
				? { status: 'cancelled', oid }
				: { status: 'failed', oid, error: describe(cause) };
		} finally {
			running.push--;
		}
		await refreshSync();
		if (outcome !== 'rejected') lastPush = { ...outcome, at: Date.now() };
		emit();
		return outcome;
	}

	/** How many times Sync fetches and merges again after losing a push race. */
	const SYNC_ATTEMPTS = 5;

	/**
	 * Checkpoint saved files, fetch, and bring the folder and the remote
	 * together: a fast-forward, a push, or one merge commit of both heads
	 * with this device's tree as the change, pushed before it is published
	 * here. A push that lost a race merges again from the same local head
	 * against the new remote, at most `SYNC_ATTEMPTS` times. A push that
	 * failed otherwise still publishes the merge here, so the folder keeps
	 * receiving, and answers `saved`. Histories that share no commit merge
	 * only on this folder's first commit, or with `allowUnrelatedHistories`.
	 */
	function runSync({
		allowUnrelatedHistories = false,
	}: SyncOptions = {}): Promise<Result<SyncOutcome, SyncError>> {
		return syncing<SyncOutcome>(async () => {
			const remote = await backend.refreshRemote();
			if (remote === undefined) return SyncError.NoRemote();
			let capturedAt = 0;
			const checkpoint = await commitNow((at) => {
				capturedAt = at;
			});
			switch (checkpoint.status) {
				case 'committed':
				case 'unchanged':
					break;
				case 'closed':
					return SyncError.Closed();
				default:
					return SyncError.Checkpoint({ outcome: checkpoint });
			}
			let local =
				checkpoint.status === 'committed' ? checkpoint.oid : checkpoint.head;
			// A folder this run gave its first commit has no history of its own
			// yet: it joins the remote's over an empty base.
			const unrelated =
				allowUnrelatedHistories ||
				(checkpoint.status === 'committed' && checkpoint.parent === undefined);
			const done = (
				head: string | undefined,
				push: PushOutcome | undefined,
			): Result<SyncOutcome, SyncError> => {
				const changedSince = lastEdit > capturedAt;
				const sent =
					push === undefined
						? head
						: push.status === 'pushed'
							? push.oid
							: undefined;
				if (!changedSince && head !== undefined && sent === head)
					return Ok({ kind: 'synced', head });
				return Ok({ kind: 'saved', head, push, changedSince });
			};
			/**
			 * Record the files again, for an edit a publish found that no
			 * commit holds, and answer the new local head.
			 */
			const recordAgain = async () => {
				const again = await commitNow((at) => {
					capturedAt = at;
				});
				if (again.status === 'committed') return again.oid;
				if (again.status === 'unchanged') return again.head;
				throw new Error(
					`Sync could not record an edit it found: ${again.status}`,
				);
			};
			// The remote head the last push was rejected against: a remote
			// that refused without moving refused for another reason.
			// `null` before any rejection; `undefined` names a remote with no branch.
			let rejectedAt: string | null | undefined = null;
			for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
				const { data: theirs, error: fetchError } = await fetchRunner.request();
				if (fetchError !== null)
					return fetchError.name === 'Closed' || closing.signal.aborted
						? SyncError.Closed()
						: SyncError.Fetch({ error: fetchError });
				if (rejectedAt !== null && theirs === rejectedAt)
					return SyncError.Failed({
						cause: new Error(
							'the remote refused the push, and its branch has not moved',
						),
					});
				rejectedAt = null;
				if (theirs === local) return done(local, undefined);
				if (
					theirs === undefined ||
					(local !== undefined &&
						(await backend.withObjects((access) =>
							isAncestor(access, theirs, local!),
						)))
				) {
					// The remote is behind: send ours, if another device could
					// hold it.
					const unsendable = await representable(local!, 'folder');
					if (unsendable.error !== null) return unsendable;
					const leaks = await carriesLocal(local!, theirs);
					if (leaks !== undefined) return SyncError.Blocked({ reason: leaks });
					const pushed = await pushCommit(local!);
					if (pushed === 'rejected') {
						rejectedAt = theirs;
						continue;
					}
					return done(local, pushed);
				}
				const refused = await representable(theirs, 'remote');
				if (refused.error !== null) return refused;
				if (
					local === undefined ||
					(await backend.withObjects((access) =>
						isAncestor(access, local!, theirs),
					))
				) {
					// This folder is behind: take theirs. The publish refuses,
					// before anything changes, a file that drops a rule this
					// folder's lists, read as it writes the file.
					const { data: published, error } = await publish(local, theirs);
					if (error !== null) return Err(error);
					if (published.kind === 'moved') {
						local = published.head;
						continue;
					}
					if (published.kind === 'edited') {
						local = await recordAgain();
						continue;
					}
					return done(theirs, undefined);
				}
				const base = await backend.withObjects((access) =>
					chooseBase(access, local!, theirs),
				);
				if (base === undefined && !unrelated)
					return SyncError.Unrelated({ head: local });
				const mine = local;
				// A rule this folder keeps, or the remote's `epicenter.json`
				// newly declares, keeps its paths out of the merge.
				const added = await addedPolicy(theirs, base);
				if (added.error !== null)
					return SyncError.Blocked({ reason: added.error });
				const { data: isLocal, error: localProblem } = await localNow(
					added.data,
				);
				if (localProblem !== null)
					return SyncError.Blocked({ reason: localProblem });
				const merged = await backend.withObjects(async (access) => {
					const result = await mergeHistories(access, {
						base,
						ours: mine,
						theirs,
						isLocal,
					});
					return writeCommitObject(access, {
						tree: result.tree,
						parents: [mine, theirs],
						message: mergeMessage(
							`Merge remote-tracking branch 'origin/${remote.branch}'`,
							result.overrides,
						),
						author,
					});
				});
				// The merged `epicenter.json` keeps every rule this folder's
				// file lists and every one the remote's newly declares, and
				// the merge carries nothing its own file keeps local; else
				// nothing is sent or written.
				const weaker = await weakened(merged, {
					from: mine,
					added: added.data,
				});
				if (weaker !== undefined) return SyncError.Blocked({ reason: weaker });
				const ownProblem = await keptByItsOwn(merged);
				if (ownProblem !== undefined)
					return SyncError.Blocked({ reason: ownProblem });
				// A merge of two sendable trees can still hold two paths only
				// their case tells apart, one from each side.
				const unsendable = await representable(merged, 'folder');
				if (unsendable.error !== null) return unsendable;
				// What stands in the way stops Sync before the merge is sent; a
				// file the person made since the checkpoint is recorded, and
				// merged in from the start.
				const way = await inTheWay(
					boundary,
					await between(mine, merged, isLocal),
				);
				const { made, ignored } = await madeHere(way.untracked);
				const inWay = wayProblem(way.failed, [...way.occupied, ...ignored]);
				if (inWay !== undefined) return SyncError.Blocked({ reason: inWay });
				if (made.length > 0) {
					local = await recordAgain();
					continue;
				}
				const leaks = await carriesLocal(merged, theirs);
				if (leaks !== undefined) return SyncError.Blocked({ reason: leaks });
				const pushed = await pushCommit(merged);
				// Nothing here changed, so merging again from `local` is safe.
				if (pushed === 'rejected') {
					rejectedAt = theirs;
					continue;
				}
				const { data: published, error } = await publish(mine, merged);
				if (error !== null) return Err(error);
				// A commit moved the branch while the merge was pushed: the next
				// Sync merges the two.
				if (published.kind === 'moved') return done(published.head, pushed);
				// An edit to a file the merge removes: recorded, then merged with
				// the merge just sent.
				if (published.kind === 'edited') {
					local = await recordAgain();
					continue;
				}
				return done(merged, pushed);
			}
			return SyncError.KeptChanging({ attempts: SYNC_ATTEMPTS });
		});
	}

	/**
	 * Synchronously: refuse every new request, refuse the ones still waiting
	 * for the backend's protection, and abort the active push and fetch. Work
	 * already inside the protection finishes on its own.
	 */
	let runners: Promise<unknown> | undefined;
	function beginClose() {
		if (closing.signal.aborted) return;
		closing.abort(new Error('The folder is closed'));
		runners = Promise.all([fetchRunner.close(), scanRunner.close()]);
		emit();
	}

	emit();

	return {
		get snapshot() {
			return snapshot;
		},
		subscribe(listener: (snapshot: GitSnapshot) => void): () => void {
			listener(snapshot);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** A known file change: existing observations become stale. */
		noteEdit() {
			const wasFresh = files.state === 'observed' && !files.stale;
			markEdited();
			if (wasFresh) emit();
		},
		status: (): Promise<Result<FilesObservation, GitError>> =>
			scanRunner.follow(),
		/**
		 * Commits the folder's current files without pushing, with `message`
		 * when a person gave one.
		 */
		commit: ({ message }: { message?: string } = {}): Promise<CommitOutcome> =>
			commitNow(undefined, message),
		sync: Object.freeze({
			run: runSync,
			async connect(
				url: string,
				options?: SyncOptions,
			): Promise<Result<SyncOutcome, SyncError>> {
				if (closing.signal.aborted) return SyncError.Closed();
				await backend.setRemote(url);
				emit();
				return runSync(options);
			},
		}),
		/**
		 * The last `depth` commits on the branch. It reads only, so it waits
		 * for no protection; once closing starts it is refused, and `close()`
		 * waits for one already running.
		 */
		log(depth: number): Promise<Result<CommitSummary[], GitError>> {
			if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
			const settled = backend.log(depth).then(
				(commits): Result<CommitSummary[], GitError> => Ok(commits),
				(cause) => GitError.Failed({ operation: 'log', cause }),
			);
			admittedWork.add(settled);
			void settled.then(() => admittedWork.delete(settled));
			return settled;
		},
		/**
		 * Resolve once nothing of this handle still uses storage: the commits,
		 * publishes, and other Git operations already inside the backend's
		 * protection finished, and the aborted network work returned. There is
		 * no last commit: a save whose request was still waiting, or whose
		 * checkpoint failed, is still uncommitted when this resolves.
		 */
		close(): Promise<void> {
			closed ??= (async () => {
				beginClose();
				await Promise.all([runners, Promise.allSettled([...admittedWork])]);
				emit();
			})();
			return closed;
		},
	};
}
