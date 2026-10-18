/**
 * History coordination for one opened folder (ADR-0468, ADR-0469, ADR-0471,
 * ADR-0576).
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
 * of the local head and the remote's (`mergeHistories`), with this device as
 * the writer acting. A merge commit is pushed before anything here changes,
 * so a push that lost a race leaves nothing to undo: Sync fetches and merges
 * again from the same local head. A tree that lands is published over the
 * files by the one write, holding the folder's save lock, the live file as
 * the writer acting, so text typed while Sync runs stands. Each write lands
 * whole, so a publish cut off partway is ordinary changed files, which the
 * next Sync records and merges (ADR-0545).
 *
 * Status scans take no protection. Callers who ask while a scan is running
 * share the one scan that follows it, so a burst of requests costs two scans
 * and the last one reads the folder after every request was made.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, LockingStorage } from '../boundary.js';
import { describe, UnconfirmedWrite } from '../errors.js';
import type { FolderHistory } from '../folder.js';
import { sameContent } from '../merge-file.js';
import { callObserver } from '../observer.js';
import {
	ancestors,
	collisionKey,
	isPortablePath,
	pathProblem,
} from '../paths.js';
import { confirmedPut, writeFile } from '../write.js';
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
import { isGitignore } from './scope.js';
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

export function createHistory({
	backend,
	boundary,
	author,
	landed = () => {},
}: {
	backend: GitBackend;
	boundary: LockingStorage;
	author: Author;
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
	 * The history source now, read for a commit or a status: every file
	 * `tracked` holds, and every other portable file `.gitignore` does not
	 * exclude (ADR-0592). The `.gitignore` files are read first, since they
	 * decide what else is read; an ignored file that is not tracked is never
	 * read. A tracked file stays source whatever `.gitignore` says, as in Git.
	 * A file removed while it is read is left out, as if the listing had
	 * missed it; a file that cannot be read throws, naming it.
	 */
	async function captureSource(tracked: ReadonlyMap<string, unknown>) {
		const { data: listed, error } = await boundary.list();
		if (error !== null) throw new Error(error.message);
		const paths = listed.files
			.map(({ path }) => path)
			.filter((path) => isPortablePath(path));
		const rules = await readRules(paths, tracked);
		const untracked = paths.filter((path) => !tracked.has(path));
		const ignored =
			untracked.length === 0
				? new Set<string>()
				: await backend.ignoredPaths(untracked, rules);
		const kept = paths.filter((path) => !ignored.has(path));
		const source = await readFiles(kept.filter((path) => !rules.has(path)));
		for (const path of kept) {
			const bytes = rules.get(path);
			if (bytes !== undefined) source.set(path, bytes);
		}
		return new Map([...source].sort(([a], [b]) => (a < b ? -1 : 1)));
	}

	/**
	 * The bytes of every `.gitignore` among `paths` that is a rule: read from
	 * the root down, so a file `tracked` lacks under a directory a shallower
	 * rule excludes is passed over, as Git never reads one there. A rule file
	 * a pattern names itself still applies; whether it is source is the
	 * caller's question. A tracked
	 * rule file is source, and read, wherever it is. Rule files at one depth
	 * sit in different directories, so only shallower ones decide them.
	 */
	async function readRules(
		paths: readonly string[],
		tracked: ReadonlyMap<string, unknown>,
	) {
		const depth = (path: string) => path.split('/').length;
		const byDepth = new Map<number, string[]>();
		for (const path of paths.filter(isGitignore))
			byDepth.set(depth(path), [...(byDepth.get(depth(path)) ?? []), path]);
		const rules = new Map<string, Uint8Array>();
		for (const level of [...byDepth.keys()].sort((a, b) => a - b)) {
			const candidates = byDepth.get(level)!;
			// A rule file is passed over only when its directory, or one above
			// it, is excluded; one that a pattern names itself, such as
			// `**/.gitignore`, still applies, though it is no source.
			const directories = [
				...new Set(
					candidates
						.filter((path) => !tracked.has(path) && path.includes('/'))
						.map((path) => path.slice(0, path.lastIndexOf('/') + 1)),
				),
			];
			const excluded =
				directories.length === 0
					? new Set<string>()
					: await backend.ignoredPaths(directories, rules);
			const read = await readFiles(
				candidates.filter(
					(path) =>
						tracked.has(path) ||
						!excluded.has(path.slice(0, path.lastIndexOf('/') + 1)),
				),
			);
			for (const [path, bytes] of read) rules.set(path, bytes);
		}
		return rules;
	}

	/** The rule files now, for a question about untracked paths. */
	async function currentRules(tracked: ReadonlyMap<string, unknown>) {
		const { data: listed, error } = await boundary.list();
		if (error !== null) throw new Error(error.message);
		return readRules(
			listed.files
				.map(({ path }) => path)
				.filter((path) => isPortablePath(path)),
			tracked,
		);
	}

	/** The bytes of `paths`, leaving out a file removed meanwhile. */
	async function readFiles(paths: readonly string[]) {
		const files = new Map<string, Uint8Array>();
		const unreadable: string[] = [];
		for (const path of paths) {
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
				const head = await backend.readBranch();
				const committed = await headFiles(head);
				// Status shows what a commit would record.
				const hashes = await hashFiles(await captureSource(committed));
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
		const committed = await headFiles(parent);
		const included = await captureSource(committed);
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

	/** The files `from` and `to` hold, and the paths Sync changes between them. */
	async function between(from: string | undefined, to: string) {
		const [before, after] = await Promise.all([headFiles(from), headFiles(to)]);
		const changes = diffFileMaps(before, after);
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
	 * `ignored`: a file `from` never tracked that `.gitignore` excludes where
	 * `to` adds one, which Sync never reads, takes into history, or replaces;
	 * Sync stops for it whatever bytes it holds.
	 * `made`: any other file `from` never tracked where `to` adds different
	 * bytes, which the person made here and Sync records and merges.
	 * `failed` when the folder cannot be listed.
	 */
	async function inTheWay(
		storage: Pick<FolderStorage, 'list' | 'read'>,
		{ before, after, changes }: Between,
	): Promise<{
		readonly occupied: readonly string[];
		readonly ignored: readonly string[];
		readonly made: readonly string[];
		readonly failed?: string;
	}> {
		const { data: listed, error } = await storage.list();
		if (error !== null)
			return { occupied: [], ignored: [], made: [], failed: error.message };
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
		// Untracked files where `to` adds one: the ignored ones are classified
		// by the rules alone, before anything reads them.
		const colliding = changes
			.map(({ path }) => path)
			.filter(
				(path) => !before.has(path) && after.has(path) && present.has(path),
			);
		const excluded =
			colliding.length === 0
				? new Set<string>()
				: await backend.ignoredPaths(colliding, await currentRules(before));
		const ignored = colliding.filter((path) => excluded.has(path));
		const made: string[] = [];
		for (const path of colliding) {
			if (excluded.has(path)) continue;
			const read = await storage.read(path);
			// A file that cannot be read is no file to record: Sync stops.
			if (read.error !== null) occupied.push(path);
			else if (!sameContent(read.data.bytes, await blobOf(after.get(path))))
				made.push(path);
		}
		return { occupied, ignored, made };
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
	 * (ADR-0576), the live file as the writer acting: one still at `from`'s
	 * bytes takes `to`'s, and one edited since keeps the units it changed.
	 * Each file is checked and written holding the folder's save lock
	 * (`lock`), one file at a time, so no cooperating save lands between its
	 * check and its write, and a save waits for one file, never for the whole
	 * publish. Removals go first, in one hold of the lock: every one is
	 * checked against `from`'s bytes, then all are made, with the directories
	 * they empty after them, so a file can take a directory's place and the
	 * reverse; an empty directory where a file goes is removed too.
	 *
	 * `edited` when a file `to` removes holds an edit no commit has, answered
	 * before anything changed: Sync records it and merges again, so the
	 * delete wins and the edit stays in history. Every write lands whole, so
	 * a publish that stops partway leaves each file at its old bytes or its
	 * new ones, and `refs/epicenter/publishing` says which publish they
	 * belong to until the branch moves: the next commit finishes it first
	 * (`finishPublishing`). `resuming` is that second run. The files hold part
	 * of `to` already, so recording an edit first would record that part as
	 * this device's: a file `to` removes that was edited after the cut stays,
	 * and a file the person made where `to` adds one, ignored aside, takes
	 * `to`'s as an addition on both sides, the live file winning.
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
		const plan = await between(from, to);
		const way = await inTheWay(boundary, plan);
		const { made, ignored } = way;
		const refused = wayProblem(way.failed, [...way.occupied, ...ignored]);
		if (refused !== undefined) return SyncError.Blocked({ reason: refused });
		// A file the person made where `to` adds one, which no commit holds:
		// recorded first, it merges with `to`'s as an addition on both sides.
		// Resuming, part of `to` is in the files already, so it joins `to`'s
		// here instead.
		if (made.length > 0 && !resuming) return Ok({ kind: 'edited' } as const);
		const adopted = new Set(made);
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
				async (held): Promise<Result<'removed' | 'edited', SyncError>> => {
					const targets: { path: string; sha256: string }[] = [];
					for (const path of removals) {
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
					// holds yet: recorded first, the merge follows a move with the
					// incoming edit, and a removal names what it overrode.
					if (!resuming)
						for (const path of writes) {
							if (blobs.get(path)!.was === null) continue;
							if ((await held.read(path)).error?.name === 'NotFound')
								return Ok('edited');
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
			for (const path of writes) {
				const { was, next } = blobs.get(path)!;
				const { data: wrote, error } = await boundary.lock(async (held) => {
					// An empty directory where the file goes, which a removal
					// cut off before its own prune can leave.
					for (const directory of directories
						.filter(
							(directory) =>
								directory === path || directory.startsWith(`${path}/`),
						)
						.sort((a, b) => b.length - a.length))
						await held.rmdir(directory);
					// A file the person made where `to` adds one joins `to`'s as
					// an addition on both sides.
					return writeFile(held, path, was, next, {
						winner: 'theirs',
						joining: adopted.has(path),
					});
				});
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
	 * with this device as the writer acting, pushed before it is published
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
					// This folder is behind: take theirs.
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
				const merged = await backend.withObjects(async (access) => {
					const result = await mergeHistories(access, {
						base,
						ours: mine,
						theirs,
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
				// A merge of two sendable trees can still hold two paths only
				// their case tells apart, one from each side.
				const unsendable = await representable(merged, 'folder');
				if (unsendable.error !== null) return unsendable;
				// What stands in the way stops Sync before the merge is sent; a
				// file the person made since the checkpoint is recorded, and
				// merged in from the start.
				const way = await inTheWay(boundary, await between(mine, merged));
				const { made, ignored } = way;
				const inWay = wayProblem(way.failed, [...way.occupied, ...ignored]);
				if (inWay !== undefined) return SyncError.Blocked({ reason: inWay });
				if (made.length > 0) {
					local = await recordAgain();
					continue;
				}
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
