/**
 * History coordination for one opened folder (ADR-0468, ADR-0469, ADR-0471).
 *
 * File saves never wait here. A commit captures the whole portable folder,
 * writes blobs and trees, writes a commit on the pinned branch head, and
 * moves the branch with a compare-and-swap. It never reads or writes the
 * shared index to build that commit. A moved branch leaves the candidate
 * unreachable and is reported; there is no retry loop.
 *
 * The backend's exclusive protection is the only thing that orders commits,
 * pulls, and staging, in this handle and across tabs. This module adds no
 * queue of its own for them. A commit happens only when asked, by `commit`
 * or by sync's checkpoint (ADR-0529); a save never asks for one. A commit
 * waits for the protection and then reads the folder, so it sees every save
 * that landed while it waited. Closing refuses one still waiting.
 *
 * Pushes and fetches have runners of their own, because network work never
 * runs under the protection. Each push pins the commit it sends. Network
 * transfers require an explicit request. A caller that
 * stops waiting before its push or fetch starts leaves no transport behind.
 * Incoming changes are explicit: `fetch` records the remote head,
 * `pullFastForward` publishes a clean fast-forward, and `mergeIncoming`
 * publishes a clean fast-forward or a two-parent merge. Both go through one
 * publication owner, which in the browser requires every captured file and
 * the index unchanged before it writes. A browser update that stops partway
 * stays pending: staging, commits, and new incoming updates wait until
 * `recoverIncoming` is asked for, and nothing else resumes it. File saves
 * are not held back.
 *
 * A merge with conflicts is never left in the files: `mergeIncoming`
 * refuses it and writes nothing, and sync captures it for a person to
 * settle. A merge another Git program began (`MERGE_HEAD`) blocks commits
 * and incoming updates until it is finished or abandoned with Git.
 *
 * `sync.run()` composes these steps: a checkpoint, a fetch, a merge with
 * sync's own rules for rows and `kv.json` (`syncMerge`), and a push. When
 * those rules hold a conflict, it returns an attempt and writes nothing
 * more; the owner keeps that one current attempt until another run, a
 * resolve, or closing. `sync.resolve()` merges the captured commits again
 * with the chosen text, publishes through the same incoming publication
 * over a clean folder still at the captured head, and pushes.
 *
 * Status scans take no protection. Callers who ask while a scan is running
 * share the one scan that follows it, so a burst of requests costs two scans
 * and the last one reads the folder after every request was made. That shared
 * scan shares one observation among callers, and it
 * never commits or pushes.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileBoundary, FileChange } from '../boundary.js';
import { hashBytes } from '../capture.js';
import type { FolderDefinition } from '../definition.js';
import { describe, UnconfirmedWrite } from '../errors.js';
import { callObserver } from '../observer.js';
import { ancestors, collisionKey, pathProblem } from '../paths.js';
import { byCodePoint } from './attributes.js';
import type {
	GitBackend,
	GitRemote,
	IncomingPlan,
	PathStatus,
	PendingIncoming,
	RecordedIncoming,
	RecoverIncomingResult,
} from './backend.js';
import {
	type ConflictVersion,
	GitError,
	type MergeConflict,
	MergeError,
	PullError,
	SyncError,
} from './errors.js';
import { type MergePath, mergeBases, prepareMerge } from './merge.js';
import { commitSubject, messageProblem, type PathChange } from './messages.js';
import {
	type Author,
	type CommitSummary,
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
import { createPassRunner, type PassRunner } from './runner.js';
import { sourceFiles } from './scope.js';
import {
	type HeldAttempt,
	type SyncAttempt,
	type SyncChoices,
	type SyncCommits,
	type SyncOutcome,
	syncMerge,
} from './sync.js';

export { GitError, MergeError, PullError };

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
	/** The caller's signal aborted; the pass may still complete. */
	| { readonly status: 'stoppedWaiting' }
	| { readonly status: 'closed' };

export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'noRemote' }
	| { readonly status: 'nothingToPush' }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	/** The host did not acknowledge the push; no commit identity is known. */
	| { readonly status: 'unconfirmed'; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string | undefined }
	| { readonly status: 'skipped'; readonly reason: string }
	/** The caller's signal aborted; the push may still complete. */
	| { readonly status: 'stoppedWaiting' }
	| { readonly status: 'closed' };

export type FetchOutcome = {
	readonly status: 'fetched';
	/** The remote branch head, or undefined when the remote has no such branch. */
	readonly oid: string | undefined;
};

export type PullOutcome =
	| { readonly status: 'upToDate'; readonly head: string | undefined }
	| { readonly status: 'ahead'; readonly head: string }
	| {
			readonly status: 'fastForwarded';
			readonly from: string | undefined;
			readonly to: string;
			readonly changedPaths: readonly string[];
	  };

/** A merge fast-forwards when it can, and otherwise records a two-parent commit. */
export type MergeOutcome =
	| PullOutcome
	| {
			readonly status: 'merged';
			readonly from: string;
			/** The merge commit. Its parents are `from` and `fetched`. */
			readonly to: string;
			readonly fetched: string;
			readonly changedPaths: readonly string[];
	  };

/** How `mergeIncoming` treats competing changes; a conflict always writes nothing. */
export type MergeConflictPolicy = {
	/**
	 * Merge histories that share no commit over an empty base, as
	 * `git merge --allow-unrelated-histories` does. The merge commit's parents
	 * are both heads, so both roots stay reachable. A path both sides hold
	 * with different bytes is a two-sided addition and conflicts like any
	 * competing change; root `kv.json` merges by key against no base. Default
	 * `false`: such histories are `UnsupportedHistory` with `bases: 0`, and
	 * nothing is written. Several merge bases are refused either way.
	 */
	readonly allowUnrelatedHistories?: boolean;
	/**
	 * With a refused conflict, carry each conflicted file's committed bytes
	 * on both sides in `Conflicted.versions`, so a person can compare them
	 * without anything being written. Default `false`.
	 */
	readonly versions?: boolean;
};

/** A staged commit that landed. */
export type StagedCommit = {
	readonly oid: string;
	readonly parent: string | undefined;
};

/** What `recoverIncoming` did with a pending incoming update. */
export type RecoverOutcome =
	/** Nothing was pending. */
	| { readonly status: 'none' }
	/**
	 * The record was empty: its admission never finished, so no authored
	 * file was changed by it. It was removed, and status is observed again.
	 */
	| { readonly status: 'admissionCleared' }
	/**
	 * The branch already named the published commit, so the record was
	 * cleared. No file was written; status is observed again, not assumed.
	 */
	| { readonly status: 'cleared'; readonly pending: RecordedIncoming }
	/** Changed paths at their before state were written, then the index and branch. */
	| {
			readonly status: 'completed';
			readonly pending: RecordedIncoming;
			readonly changedPaths: readonly string[];
	  };

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
		readonly pull: Activity;
		readonly merge: Activity;
	};
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
	readonly lastFetch:
		| Attempt<{ readonly result: Result<FetchOutcome, GitError> }>
		| undefined;
	readonly lastPull:
		| Attempt<{ readonly result: Result<PullOutcome, PullError | GitError> }>
		| undefined;
	readonly lastMerge:
		| Attempt<{
				readonly result: Result<
					MergeOutcome,
					MergeError | PullError | GitError
				>;
		  }>
		| undefined;
	/**
	 * An incoming update whose publication began and has not been recovered,
	 * as last read. While there is one, staging, commits, and new incoming
	 * updates wait for `recoverIncoming()`; file saves continue. Absent where
	 * none is pending, and on folders that never keep one.
	 */
	readonly pendingIncoming?: PendingIncoming;
	readonly closed: boolean;
};

export type CommitAndPushResult = {
	readonly commit: CommitOutcome;
	readonly push: PushOutcome;
};

export type History = ReturnType<typeof createHistory>;

export function createHistory({
	backend,
	boundary,
	author,
	definition,
	landed = () => {},
}: {
	backend: GitBackend;
	boundary: FileBoundary;
	author: Author;
	/** The prepared definition whose rows sync merges by field; without it, rows merge as text. */
	definition?: FolderDefinition;
	/** Paths an incoming update wrote or removed, whether or not it completed. */
	landed?: (paths: readonly string[]) => void;
}) {
	let clock = 0;
	let lastEdit = 0;
	/**
	 * Aborted when closing starts. From then on nothing new is admitted, and a
	 * request still waiting for the backend's protection is refused instead of
	 * running after the folder closed. Work already inside the protection is
	 * not interrupted.
	 */
	const closing = new AbortController();
	/** Commits, pulls, and merges of this handle that are waiting or running. */
	const running = { commit: 0, pull: 0, merge: 0 };
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
	let lastFetch: GitSnapshot['lastFetch'];
	let lastPull: GitSnapshot['lastPull'];
	let lastMerge: GitSnapshot['lastMerge'];
	let pendingIncoming: PendingIncoming | undefined;
	let remoteSeq = 0;
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
				push: { active: pushRunner.active },
				fetch: { active: fetchRunner.active },
				pull: { active: running.pull > 0 },
				merge: { active: running.merge > 0 },
			},
			lastCommit,
			lastPush,
			lastFetch,
			lastPull,
			lastMerge,
			pendingIncoming,
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

	/** Read the pending incoming record again. Reading resumes nothing. */
	async function refreshPending() {
		try {
			pendingIncoming = await backend.pendingIncoming?.();
		} catch {
			// An unreadable record keeps the last observation; `blocked` names it.
		}
	}

	async function refreshSync() {
		await refreshPending();
		try {
			const [head, remote] = await Promise.all([
				backend.readBranch(),
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

	async function capture() {
		const { data: captured, error: captureError } = await boundary.capture();
		if (captureError !== null) throw new Error(captureError.message);
		if (captured.unreadable.length > 0)
			throw new Error(
				`${captured.unreadable.length} files could not be read: ${captured.unreadable
					.map((item) => item.path)
					.join(', ')}`,
			);
		return captured.files;
	}

	/** Captured files that are history source under the shared scope rule. */
	function source(
		current: ReadonlyMap<string, Uint8Array>,
		tracked: ReadonlyMap<string, unknown>,
	) {
		return sourceFiles(current, tracked, backend.ignoredPaths);
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
	 * An operation failed after some of its file changes landed. The cached
	 * clean observation no longer describes the folder: mark it stale and
	 * start a fresh scan if none is running. This requests no commit.
	 */
	function markLanded() {
		markEdited();
		void scanRunner.attempt();
	}

	const scanRunner = createPassRunner<void, Result<FilesObservation, GitError>>(
		{
			async run() {
				const capturedAt = ++clock;
				try {
					const captured = await capture();
					const head = await backend.readBranch();
					const committed = await headFiles(head);
					const hashes = await hashFiles(await source(captured, committed));
					const value: FilesObservation = {
						head,
						changes: diffFileMaps(committed, hashes),
					};
					observeFiles(capturedAt, value);
					await refreshSync();
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
		},
	);

	/** Why this folder's history cannot take a whole-folder commit or update now. */
	async function wholeFolderProblem(): Promise<string | undefined> {
		return (await backend.blocked()) ?? (await backend.checkpointProblem());
	}

	/** One whole-folder commit, after waiting for the backend's protection. */
	function commitCurrentFiles(
		onCapture?: (capturedAt: number) => void,
	): Promise<CommitOutcome> {
		return exclusive(async (): Promise<CommitOutcome> => {
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return { status: 'blocked', reason: blocked };
			// Pin the parent, then capture, both inside the Git lock. A pull or
			// staged commit that changed files and the branch while this pass
			// waited is part of the capture, so an older capture can never be
			// committed on top of a newer parent. An external branch move after
			// this point still fails the compare-and-swap below.
			const parent = await backend.readBranch();
			const capturedAt = ++clock;
			onCapture?.(capturedAt);
			const current = await capture();
			const committed = await headFiles(parent);
			const included = await source(current, committed);
			const built = await backend.withObjects(async (access) => {
				const tree = await writeFilesTree(access, included);
				const parentTree =
					parent === undefined ? EMPTY_TREE : await commitTree(access, parent);
				if (tree === parentTree) return undefined;
				const changes = diffFileMaps(
					committed,
					await readTreeFiles(access, tree),
				);
				const message = commitSubject(changes);
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
		});
	}

	/**
	 * Run one commit, pull, or merge of this handle. It counts as active from
	 * the moment it is asked for, including any wait for the backend's
	 * protection, and `close()` waits for it. `work` must not reject.
	 */
	function owned<T>(kind: keyof typeof running, work: () => Promise<T>) {
		running[kind]++;
		const completion = Promise.withResolvers<T>();
		const settled = completion.promise.finally(() => {
			running[kind]--;
			admittedWork.delete(settled);
			emit();
		});
		admittedWork.add(settled);
		// Register before work or observers can synchronously close this handle.
		try {
			void work().then(completion.resolve, completion.reject);
		} catch (cause) {
			completion.reject(cause);
		}
		emit();
		return settled;
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

	/** An operation that threw: `Unconfirmed` when a private write may have landed. */
	const thrown = (operation: string, cause: unknown) =>
		cause instanceof UnconfirmedWrite
			? GitError.Unconfirmed({ operation, cause })
			: GitError.Failed({ operation, cause });

	/** Record what a commit that ran did and what is now known of the remote. */
	async function settleCommit(outcome: CommitOutcome) {
		lastCommit = { ...outcome, at: Date.now() };
		await refreshSync();
		emit();
	}

	/**
	 * An explicit commit. It waits for the backend's protection and captures
	 * inside it. Closing refuses it while it still waits; once inside, it runs
	 * to its end and reports what it did.
	 */
	function commitNow(
		onCapture?: (capturedAt: number) => void,
	): Promise<CommitOutcome> {
		if (closing.signal.aborted) return Promise.resolve({ status: 'closed' });
		return owned('commit', async (): Promise<CommitOutcome> => {
			let outcome: CommitOutcome;
			try {
				outcome = await commitCurrentFiles(onCapture);
			} catch (cause) {
				// Refused while waiting: nothing ran, so no attempt is recorded.
				if (refusedByClose(cause)) return { status: 'closed' };
				outcome = failedCommit(cause);
			}
			await settleCommit(outcome);
			return outcome;
		});
	}

	const pushRunner = createPassRunner<void, PushOutcome>({
		async run(_input, signal) {
			if (backend.remote === undefined) return { status: 'noRemote' };
			const oid = await backend.readBranch();
			if (oid === undefined) return { status: 'nothingToPush' };
			const sequence = ++remoteSeq;
			let outcome: PushOutcome;
			try {
				await backend.push(oid, signal);
				outcome = { status: 'pushed', oid };
			} catch (cause) {
				outcome = signal.aborted
					? { status: 'cancelled', oid }
					: { status: 'failed', oid, error: describe(cause) };
			}
			// A push that started before a newer fetch or push must not replace its observation.
			if (sequence === remoteSeq) await refreshSync();
			lastPush = { ...outcome, at: Date.now() };
			emit();
			return outcome;
		},
		failed: (cause) => ({ status: 'failed', oid: '', error: describe(cause) }),
		closed: () => ({ status: 'closed' }),
		onChange: () => emit(),
	});

	const fetchRunner = createPassRunner<void, Result<FetchOutcome, GitError>>({
		async run(_input, signal) {
			if (backend.remote === undefined) return GitError.NoRemote();
			const sequence = ++remoteSeq;
			let result: Result<FetchOutcome, GitError>;
			try {
				result = Ok({ status: 'fetched', oid: await backend.fetch(signal) });
			} catch (cause) {
				result = GitError.Failed({ operation: 'fetch', cause });
			}
			if (sequence === remoteSeq) await refreshSync();
			lastFetch = { result, at: Date.now() };
			emit();
			return result;
		},
		failed: (cause) => GitError.Failed({ operation: 'fetch', cause }),
		closed: () => GitError.Closed(),
		onChange: () => emit(),
	});

	/** The pinned branch head and fetched remote head, and how they relate. */
	type Pinned =
		| {
				readonly relation: 'upToDate';
				readonly head: string | undefined;
				readonly fetched: string;
		  }
		| {
				readonly relation: 'fastForward';
				readonly head: string | undefined;
				readonly fetched: string;
		  }
		| {
				readonly relation: 'ahead' | 'diverged';
				readonly head: string;
				readonly fetched: string;
		  };

	/** Why no incoming update can start now: one is pending, or commits are blocked. */
	async function incomingRefused() {
		const pending = await backend.pendingIncoming?.();
		if (pending !== undefined) return PullError.IncomingPending({ pending });
		const blocked = await wholeFolderProblem();
		if (blocked !== undefined) return PullError.Blocked({ reason: blocked });
		return undefined;
	}

	/** Pin both heads for one incoming update, inside the backend's protection. */
	async function pinIncoming(): Promise<Result<Pinned, PullError>> {
		const refused = await incomingRefused();
		if (refused !== undefined) return refused;
		const fetched = await backend.readRemoteTracking();
		if (fetched === undefined) return PullError.NoFetchedHead();
		const head = await backend.readBranch();
		if (head === fetched) return Ok({ relation: 'upToDate', head, fetched });
		if (
			head === undefined ||
			(await backend.withObjects((access) => isAncestor(access, head, fetched)))
		)
			return Ok({ relation: 'fastForward', head, fetched });
		const contained = await backend.withObjects((access) =>
			isAncestor(access, fetched, head),
		);
		return Ok({ relation: contained ? 'ahead' : 'diverged', head, fetched });
	}

	/** The folder an incoming update found clean, and what its publication requires. */
	type Clean = {
		readonly raw: ReadonlyMap<string, Uint8Array>;
		readonly committed: ReadonlyMap<string, TreeFile>;
		readonly current: ReadonlyMap<string, Uint8Array>;
		readonly baseline: IncomingPlan['baseline'];
	};

	/**
	 * The entire folder must be clean, including staged changes. The baseline
	 * is the hash of every captured file and the exact index bytes checked
	 * against the pinned head. A browser publication requires both unchanged, so the clean
	 * observation recorded after it holds for the folder it published over.
	 */
	async function cleanFolder(
		head: string | undefined,
	): Promise<Result<Clean, PullError>> {
		const raw = await capture();
		const committed = await headFiles(head);
		const current = await source(raw, committed);
		const dirty = diffFileMaps(committed, await hashFiles(current));
		if (dirty.length > 0)
			return PullError.Dirty({ paths: dirty.map((change) => change.path) });
		const index = await backend.readIndex();
		if (!(await backend.indexMatchesHead({ head, bytes: index })))
			return PullError.StagedChanges();
		const files = new Map<string, string>();
		for (const [path, bytes] of raw) files.set(path, await hashBytes(bytes));
		return Ok({ raw, committed, current, baseline: { files, index } });
	}

	/** Refuse a tree, the files of `commit`, that this folder cannot write as plain bytes. */
	async function representable(
		commit: string,
		files: ReadonlyMap<string, TreeFile>,
	): Promise<Result<undefined, PullError>> {
		const unsupported = [...files]
			.filter(([, entry]) => entry.mode !== '100644')
			.map(([path]) => path);
		if (unsupported.length > 0)
			return PullError.Unrepresentable({
				paths: unsupported,
				reason:
					'symbolic links, submodules, and executable files are not plain folder files',
			});
		const invalid = [...files.keys()].filter(
			(path) => pathProblem(path) !== undefined,
		);
		if (invalid.length > 0)
			return PullError.Unrepresentable({
				paths: invalid,
				reason: 'some paths are not valid folder paths',
			});
		// An update writes each blob's bytes as they are stored. A commit that
		// declares a filter or a conversion for a path means something else by
		// those bytes: under `filter=lfs` the blob is a pointer, not the audio.
		// Every path is asked about, against the commit's own attributes, so a
		// commit that only adds an attribute over a file it does not touch is
		// refused as well.
		const declared = await backend.incomingAttribute(commit, files);
		if (declared !== undefined)
			return PullError.Unrepresentable({
				paths: [declared.path],
				reason: `the incoming commit declares the Git attribute ${declared.attribute}, and this folder does not apply attribute filters or conversion`,
			});
		const folded = new Map<string, string>();
		for (const path of files.keys()) {
			const key = collisionKey(path);
			const existing = folded.get(key);
			if (existing !== undefined)
				return PullError.Unrepresentable({
					paths: [existing, path],
					reason: 'paths collide on case-insensitive filesystems',
				});
			folded.set(key, path);
		}
		return Ok(undefined);
	}

	/**
	 * Publish `target`, the tree of `nextHead`, over the clean folder at
	 * `head`. The one publication owner for fast-forwards and merges.
	 * Returns the paths it changed.
	 */
	async function publishIncoming({
		capturedAt,
		head,
		nextHead,
		target,
		clean,
	}: {
		capturedAt: number;
		head: string | undefined;
		nextHead: string;
		target: ReadonlyMap<string, TreeFile>;
		clean: Clean;
	}): Promise<Result<readonly string[], PullError>> {
		const { raw, current } = clean;
		const changes = diffFileMaps(clean.committed, target);
		// Ignored and untracked files are preserved, never overwritten. A
		// tracked file this same update removes is in nobody's way when the
		// backend removes the directories its removals empty.
		const leaving = new Set(
			backend.replacesDirectories
				? changes
						.filter((change) => change.kind === 'delete')
						.map((change) => change.path)
				: [],
		);
		const rawPaths = [...raw.keys()].filter((path) => !leaving.has(path));
		const staying = (path: string) => raw.has(path) && !leaving.has(path);
		const colliding = changes
			.filter((change) => change.kind === 'add')
			.map((change) => change.path)
			.filter(
				(path) =>
					staying(path) ||
					ancestors(path).some(staying) ||
					rawPaths.some((existing) => existing.startsWith(`${path}/`)),
			);
		if (colliding.length > 0) return PullError.Collision({ paths: colliding });
		const removals: FileChange[] = [];
		const writes: FileChange[] = [];
		for (const change of changes) {
			const bytes = current.get(change.path);
			if (change.kind === 'delete') {
				if (bytes === undefined)
					return PullError.Dirty({ paths: [change.path] });
				removals.push({
					kind: 'remove',
					path: change.path,
					expectedSha256: await hashBytes(bytes),
				});
				continue;
			}
			const next = await backend.withObjects((access) =>
				readBlob(access, target.get(change.path)!.oid),
			);
			const write = {
				path: change.path,
				bytes: next,
				sha256: await hashBytes(next),
			};
			writes.push(
				bytes === undefined
					? { kind: 'create', ...write }
					: {
							kind: 'replace',
							...write,
							expectedSha256: await hashBytes(bytes),
						},
			);
		}
		const changedPaths = changes.map((change) => change.path);
		const published = await backend.publishIncoming({
			expectedHead: head,
			nextHead,
			changes: [...removals, ...writes],
			paths: changedPaths,
			baseline: clean.baseline,
		});
		switch (published.status) {
			case 'published':
				await observeCommitted(capturedAt, nextHead);
				landed(changedPaths);
				return Ok(changedPaths);
			case 'refused':
				return PullError.Refused({ error: published.error });
			case 'indexChanged':
				return PullError.StagedChanges();
			case 'partial':
				markLanded();
				landed(
					published.applied.flatMap((step) =>
						step.kind === 'move' ? [step.from, step.to] : [step.path],
					),
				);
				return PullError.Partial({
					applied: published.applied,
					error: published.error,
				});
			case 'branchMoved':
				if (published.filesApplied) {
					markLanded();
					landed(changedPaths);
				}
				return PullError.BranchMoved({
					actual: published.actual,
					filesApplied: published.filesApplied,
				});
			case 'indexFailed':
				markLanded();
				landed(changedPaths);
				return PullError.IndexFailed({ error: published.error });
			case 'unconfirmed':
				// No commit is requested: whether the files, the index, or the
				// branch changed is for an explicit recovery to find out.
				markLanded();
				landed([
					...published.applied.flatMap((step) =>
						step.kind === 'move' ? [step.from, step.to] : [step.path],
					),
					...published.uncertain.filter((path) => !path.startsWith('.git/')),
				]);
				return PullError.Unconfirmed({
					applied: published.applied,
					uncertain: published.uncertain,
					error: published.error,
				});
		}
	}

	/** Apply the fetched head as a fast-forward of the clean folder. */
	async function fastForward(
		capturedAt: number,
		head: string | undefined,
		fetched: string,
	): Promise<Result<PullOutcome, PullError>> {
		const { data: clean, error: cleanError } = await cleanFolder(head);
		if (cleanError !== null) return Err(cleanError);
		const incoming = await headFiles(fetched);
		const refused = await representable(fetched, incoming);
		if (refused.error !== null) return refused;
		const { data: changedPaths, error: publishError } = await publishIncoming({
			capturedAt,
			head,
			nextHead: fetched,
			target: incoming,
			clean,
		});
		if (publishError !== null) return Err(publishError);
		return Ok({
			status: 'fastForwarded',
			from: head,
			to: fetched,
			changedPaths,
		});
	}

	async function pull(): Promise<Result<PullOutcome, PullError | GitError>> {
		if (backend.remote === undefined) return GitError.NoRemote();
		return exclusive(async () => {
			const capturedAt = ++clock;
			const { data: incoming, error: pinError } = await pinIncoming();
			if (pinError !== null) return Err(pinError);
			switch (incoming.relation) {
				case 'upToDate':
					return Ok({ status: 'upToDate', head: incoming.head });
				case 'ahead':
					return Ok({ status: 'ahead', head: incoming.head });
				case 'diverged':
					return PullError.Diverged({
						head: incoming.head,
						fetched: incoming.fetched,
					});
				case 'fastForward':
					return fastForward(capturedAt, incoming.head, incoming.fetched);
			}
		});
	}

	/**
	 * Merge the fetched head into the clean folder: a fast-forward when the
	 * branch is behind, otherwise one commit whose parents are the pinned head
	 * and the pinned fetched commit. A refusal writes no file, index entry, or
	 * ref; so does a conflict.
	 *
	 * `sync` adds sync's rules for paths both sides changed, and hears the
	 * commits a diverged merge used. With `captured`, it merges exactly those
	 * commits instead of the fetched head, and only while the branch still
	 * names the captured head (`BranchMoved` otherwise, writing nothing). A
	 * path sync held is reported as a `content` conflict.
	 */
	async function merge({
		allowUnrelatedHistories = false,
		versions = false,
		sync,
	}: {
		allowUnrelatedHistories?: boolean;
		versions?: boolean;
		sync?: {
			readonly mergePath: MergePath;
			readonly captured?: SyncCommits;
			readonly pinned?: (commits: SyncCommits, capturedAt: number) => void;
		};
	} = {}): Promise<Result<MergeOutcome, MergeError | PullError | GitError>> {
		const remote = backend.remote;
		if (remote === undefined) return GitError.NoRemote();
		return exclusive(
			async (): Promise<
				Result<MergeOutcome, MergeError | PullError | GitError>
			> => {
				const capturedAt = ++clock;
				let head: string;
				let fetched: string;
				let base: string | undefined;
				if (sync?.captured !== undefined) {
					const refused = await incomingRefused();
					if (refused !== undefined) return refused;
					const actual = await backend.readBranch();
					if (actual !== sync.captured.head)
						return PullError.BranchMoved({ actual, filesApplied: false });
					({ head, fetched, base } = sync.captured);
				} else {
					const { data: incoming, error: pinError } = await pinIncoming();
					if (pinError !== null) return Err(pinError);
					if (incoming.relation === 'upToDate')
						return Ok({ status: 'upToDate', head: incoming.head });
					if (incoming.relation === 'ahead')
						return Ok({ status: 'ahead', head: incoming.head });
					if (incoming.relation === 'fastForward')
						return fastForward(capturedAt, incoming.head, incoming.fetched);
					({ head, fetched } = incoming);
				}
				const { data: clean, error: cleanError } = await cleanFolder(head);
				if (cleanError !== null) return Err(cleanError);
				const refused = await representable(fetched, await headFiles(fetched));
				if (refused.error !== null) return refused;
				if (sync?.captured === undefined) {
					const bases = await backend.withObjects((access) =>
						mergeBases(access, head, fetched),
					);
					const unrelated = bases.length === 0 && allowUnrelatedHistories;
					if (bases.length !== 1 && !unrelated)
						return MergeError.UnsupportedHistory({
							head,
							fetched,
							bases: bases.length,
						});
					base = unrelated ? undefined : bases[0]!;
					sync?.pinned?.({ base, head, fetched }, capturedAt);
				} else sync.pinned?.(sync.captured, capturedAt);
				const message = `Merge remote-tracking branch 'origin/${remote.branch}'`;
				const prepared = await backend.withObjects((access) =>
					prepareMerge(access, {
						base,
						head,
						fetched,
						author,
						message,
						...(sync === undefined ? {} : { mergePath: sync.mergePath }),
					}),
				);
				if (prepared.kind === 'conflicted')
					return MergeError.Conflicted({
						conflicts: [
							...prepared.conflicts,
							...prepared.held.map(
								(path): MergeConflict => ({ reason: 'content', path }),
							),
						].sort((left, right) => byCodePoint(left.path, right.path)),
						...(versions
							? {
									versions: await conflictVersions(
										prepared.conflicts,
										head,
										fetched,
									),
								}
							: {}),
					});
				if (prepared.kind === 'unmergeable')
					return MergeError.Unmergeable({
						paths: prepared.paths,
						reason: prepared.reason,
					});
				const merged = await representable(prepared.commit, prepared.files);
				if (merged.error !== null) return merged;
				const { data: changedPaths, error: publishError } =
					await publishIncoming({
						capturedAt,
						head,
						nextHead: prepared.commit,
						target: prepared.files,
						clean,
					});
				if (publishError !== null) return Err(publishError);
				return Ok({
					status: 'merged',
					from: head,
					to: prepared.commit,
					fetched,
					changedPaths,
				});
			},
		);
	}

	/**
	 * Each conflicted file's committed bytes at the pinned head and the pinned
	 * fetched commit, `null` where that side has no file. A path that is a
	 * directory on one side (`shape`) has no file versions to compare.
	 */
	async function conflictVersions(
		conflicts: readonly MergeConflict[],
		head: string,
		fetched: string,
	): Promise<ConflictVersion[]> {
		const shapes = new Set(
			conflicts
				.filter((conflict) => conflict.reason === 'shape')
				.map((conflict) => conflict.path),
		);
		const paths = [
			...new Set(conflicts.map((conflict) => conflict.path)),
		].filter((path) => !shapes.has(path));
		const [ours, theirs] = await Promise.all([
			headFiles(head),
			headFiles(fetched),
		]);
		return backend.withObjects(async (access) => {
			const read = (entry: TreeFile | undefined) =>
				entry === undefined ? null : readBlob(access, entry.oid);
			const result: ConflictVersion[] = [];
			for (const path of paths)
				result.push({
					path,
					ours: await read(ours.get(path)),
					theirs: await read(theirs.get(path)),
				});
			return result;
		});
	}

	/**
	 * One explicit incoming update, owned until it settles. Closing refuses it
	 * while it still waits for the protection.
	 */
	function incomingNow<T, E extends { name: string }>(
		kind: 'pull' | 'merge',
		work: () => Promise<Result<T, E | GitError>>,
		record: (attempt: Attempt<{ result: Result<T, E | GitError> }>) => void,
	): Promise<Result<T, E | GitError>> {
		if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
		return owned(kind, async () => {
			let result: Result<T, E | GitError>;
			try {
				result = await work();
			} catch (cause) {
				if (refusedByClose(cause)) return GitError.Closed();
				result = thrown(kind, cause);
			}
			const { error: incomingError } = result;
			if (incomingError === null || incomingError.name !== 'Failed')
				await refreshSync();
			else await refreshPending();
			record({ result, at: Date.now() });
			emit();
			return result;
		});
	}

	const pullNow = () =>
		incomingNow('pull', pull, (attempt) => {
			lastPull = attempt;
		});
	function mergeNow({
		allowUnrelatedHistories,
		versions,
	}: MergeConflictPolicy = {}): Promise<
		Result<MergeOutcome, MergeError | PullError | GitError>
	> {
		return incomingNow(
			'merge',
			() => merge({ allowUnrelatedHistories, versions }),
			(attempt) => {
				lastMerge = attempt;
			},
		);
	}

	/**
	 * Recover the pending incoming update, only because someone asked. It
	 * waits for the backend's protection, and the store holds the files lock
	 * while it checks and writes. Nothing retries it; a refusal leaves the
	 * update pending and names what is in neither state.
	 */
	function recoverNow(): Promise<Result<RecoverOutcome, PullError | GitError>> {
		return manual<RecoverOutcome, PullError>('recover', async () => {
			if (backend.recoverIncoming === undefined) return Ok({ status: 'none' });
			let result: RecoverIncomingResult;
			try {
				result = await exclusive(() => backend.recoverIncoming!());
			} catch (cause) {
				if (refusedByClose(cause)) return GitError.Closed();
				markLanded();
				await refreshPending();
				emit();
				return thrown('recover', cause);
			}
			let outcome: Result<RecoverOutcome, PullError>;
			switch (result.status) {
				case 'none':
					outcome = Ok({ status: 'none' });
					break;
				case 'admissionCleared':
					// No authored file was written; status is observed again.
					markLanded();
					outcome = Ok({ status: 'admissionCleared' });
					break;
				case 'cleared':
					// No file was written, and the files are not assumed clean.
					markLanded();
					outcome = Ok({ status: 'cleared', pending: result.pending });
					break;
				case 'completed':
					markLanded();
					landed(result.changedPaths);
					outcome = Ok({
						status: 'completed',
						pending: result.pending,
						changedPaths: result.changedPaths,
					});
					break;
				case 'refused':
					outcome = PullError.RecoveryRefused({
						pending: result.pending,
						paths: result.paths,
						reason: result.reason,
					});
					break;
				case 'partial':
					markLanded();
					landed(
						result.applied.flatMap((step) =>
							step.kind === 'move' ? [step.from, step.to] : [step.path],
						),
					);
					outcome = PullError.Partial({
						applied: result.applied,
						error: result.error,
					});
					break;
				case 'unconfirmed':
					markLanded();
					landed([
						...result.applied.flatMap((step) =>
							step.kind === 'move' ? [step.from, step.to] : [step.path],
						),
						...result.uncertain.filter((path) => !path.startsWith('.git/')),
					]);
					outcome = PullError.Unconfirmed({
						applied: result.applied,
						uncertain: result.uncertain,
						error: result.error,
					});
					break;
			}
			await refreshSync();
			emit();
			return outcome;
		});
	}

	/**
	 * Stop this caller waiting when its signal aborts. A caller signal never
	 * aborts the transport; only closing the folder does.
	 */
	function until<T>(
		promise: Promise<T>,
		signal: AbortSignal | undefined,
		stopped: () => T,
	) {
		if (signal === undefined) return promise;
		if (signal.aborted) return Promise.resolve(stopped());
		return new Promise<T>((resolve) => {
			const abort = () => resolve(stopped());
			signal.addEventListener('abort', abort, { once: true });
			promise.then((value) => {
				signal.removeEventListener('abort', abort);
				resolve(value);
			});
		});
	}

	const stoppedPush = (): PushOutcome => ({ status: 'stoppedWaiting' });

	/**
	 * One push or fetch for a caller that may stop waiting. A caller who has
	 * left when the pass's turn comes starts no transport. One who leaves after
	 * the transport started is told so while it carries on.
	 */
	function network<T>(
		runner: PassRunner<void, T>,
		signal: AbortSignal | undefined,
		stopped: () => T,
	) {
		if (signal === undefined) return runner.request();
		return until(
			runner.request(undefined, { signal, withdrawn: stopped }),
			signal,
			stopped,
		);
	}

	/**
	 * Admit one explicit Git operation for its whole lifetime, including any
	 * refresh after the backend call. Refused once closing starts; `close()`
	 * drains admitted work before storage is released.
	 */
	function manual<T, E = never>(
		operation: string,
		work: () => Promise<Result<T, E | GitError>>,
	): Promise<Result<T, E | GitError>> {
		if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
		const settled = work().catch(
			(cause): Result<T, E | GitError> =>
				refusedByClose(cause) ? GitError.Closed() : thrown(operation, cause),
		);
		admittedWork.add(settled);
		void settled.then(() => admittedWork.delete(settled));
		return settled;
	}

	function guarded<T>(
		operation: string,
		work: () => Promise<T>,
	): Promise<Result<T, GitError>> {
		return manual<T>(operation, async () => Ok(await work()));
	}

	/**
	 * Commit the index onto the branch head. Refused, writing nothing, while
	 * an incoming update is pending or the repository is blocked, including a
	 * merge another Git program began.
	 */
	async function commitStaged(
		message: string,
	): Promise<Result<StagedCommit, GitError>> {
		const problem = messageProblem(message);
		if (problem !== undefined)
			return GitError.InvalidMessage({ reason: problem });
		const pending = await backend.pendingIncoming?.();
		if (pending !== undefined) return GitError.IncomingPending({ pending });
		const blocked = await backend.blocked();
		if (blocked !== undefined)
			return GitError.Failed({ operation: 'commit', cause: blocked });
		let changedPaths = 0;
		let result:
			| Awaited<ReturnType<GitBackend['commitIndex']>>
			| { readonly status: 'pending'; readonly pending: PendingIncoming }
			| { readonly status: 'blocked'; readonly reason: string };
		try {
			result = await exclusive(async () => {
				const pending = await backend.pendingIncoming?.();
				if (pending !== undefined)
					return { status: 'pending', pending } as const;
				const blocked = await backend.blocked();
				if (blocked !== undefined)
					return { status: 'blocked', reason: blocked } as const;
				changedPaths = (await backend.pathStatus()).filter(
					(path) => path.index !== ' ' && path.index !== '?',
				).length;
				return backend.commitIndex(message, author);
			});
		} catch (cause) {
			if (refusedByClose(cause)) return GitError.Closed();
			return thrown('commit', cause);
		}
		if (result.status === 'committed') {
			lastCommit = {
				...result,
				message,
				changedPaths,
				indexWarning: undefined,
				at: Date.now(),
			};
		}
		await refreshSync();
		if (files.state === 'observed') files = { ...files, stale: true };
		emit();
		switch (result.status) {
			case 'pending':
				return GitError.IncomingPending({ pending: result.pending });
			case 'blocked':
				return GitError.Failed({ operation: 'commit', cause: result.reason });
			case 'nothing':
				return GitError.NothingToCommit();
			case 'branchMoved':
				return GitError.BranchMoved({
					expected: result.expected,
					actual: result.actual,
				});
			case 'committed':
				return Ok({ oid: result.oid, parent: result.parent });
		}
	}

	/** The one attempt `sync.resolve` accepts now, and how its choices settle. */
	let current: HeldAttempt | undefined;
	/** Numbers runs, so a run another one overtook never becomes current. */
	let runs = 0;

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
			(cause): Result<T, SyncError> => SyncError.Failed({ cause }),
		);
		admittedWork.add(settled);
		void settled.then(() => admittedWork.delete(settled));
		return settled;
	}

	/**
	 * Send `head` unless the remote was just seen there, and say whether the
	 * remote is confirmed to hold every save captured at `capturedAt`.
	 */
	async function settleSync(
		head: string | undefined,
		remoteHead: string | undefined,
		capturedAt: number,
	): Promise<SyncOutcome> {
		const push =
			head === undefined || head === remoteHead
				? undefined
				: await pushRunner.request();
		const changedSince = lastEdit > capturedAt;
		const sent =
			push === undefined
				? head
				: push.status === 'pushed'
					? push.oid
					: undefined;
		if (!changedSince && head !== undefined && sent === head)
			return { kind: 'synced', head };
		return { kind: 'saved', head, push, changedSince };
	}

	const recordMerge = (
		attempt: Attempt<{
			result: Result<MergeOutcome, MergeError | PullError | GitError>;
		}>,
	) => {
		lastMerge = attempt;
	};

	/**
	 * Checkpoint saved files, fetch, and merge with sync's rules. Held units
	 * and nothing else return a new current attempt; any other conflict is
	 * `Unreviewable`. Anything merged is published and pushed. Starting a run
	 * retires the previous attempt.
	 */
	function runSync(): Promise<Result<SyncOutcome | SyncAttempt, SyncError>> {
		return syncing<SyncOutcome | SyncAttempt>(async () => {
			const remote = backend.remote;
			if (remote === undefined) return SyncError.NoRemote();
			const run = ++runs;
			current = undefined;
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
			let head =
				checkpoint.status === 'committed' ? checkpoint.oid : checkpoint.head;
			// A folder this run gave its first commit has no history of its own
			// yet: its first sync adopts the remote's by merging over an empty
			// base, where two different files at one path are a conflict.
			const firstHistory =
				checkpoint.status === 'committed' && checkpoint.parent === undefined;
			const { data: fetched, error: fetchError } = await fetchRunner.request();
			if (fetchError !== null)
				return fetchError.name === 'Closed'
					? SyncError.Closed()
					: SyncError.Fetch({ error: fetchError });
			if (fetched.oid !== undefined) {
				const rules = syncMerge(definition);
				let commits: SyncCommits | undefined;
				const { data: merged, error: mergeError } = await incomingNow(
					'merge',
					() =>
						merge({
							allowUnrelatedHistories: firstHistory,
							sync: {
								mergePath: rules.mergePath,
								pinned: (pinned) => {
									commits = pinned;
								},
							},
						}),
					recordMerge,
				);
				if (mergeError?.name === 'Closed') return SyncError.Closed();
				if (mergeError?.name === 'Conflicted') {
					const other = mergeError.conflicts.filter(
						(conflict) => !rules.held.has(conflict.path),
					);
					if (other.length > 0 || commits === undefined)
						return SyncError.Unreviewable({
							conflicts: other.length > 0 ? other : mergeError.conflicts,
						});
					const held = rules.attempt(commits);
					if (run === runs && !closing.signal.aborted) current = held;
					return Ok(held.attempt);
				}
				if (mergeError !== null) return SyncError.Merge({ error: mergeError });
				head =
					merged.status === 'upToDate' || merged.status === 'ahead'
						? merged.head
						: merged.to;
			}
			return Ok(await settleSync(head, fetched.oid, capturedAt));
		});
	}

	/**
	 * Settle the current attempt with one choice per conflict, then push.
	 * Invalid choices write nothing and keep the attempt current; past that
	 * check the attempt is spent, whatever happens next. Nothing here awaits
	 * before the choices are settled into text, so later edits to the
	 * caller's object change nothing that is published.
	 */
	function resolveSync(
		attempt: SyncAttempt,
		choices: SyncChoices,
	): Promise<Result<SyncOutcome, SyncError>> {
		return syncing(async () => {
			const held = current;
			const id = (attempt as Partial<SyncAttempt> | null | undefined)?.id;
			if (held === undefined || id !== held.attempt.id)
				return SyncError.Stale({ reason: 'replaced' });
			const { data: settled, error: choiceError } = held.settle(choices);
			if (choiceError !== null) return Err(choiceError);
			current = undefined;
			let capturedAt = 0;
			const { data: merged, error: mergeError } = await incomingNow(
				'merge',
				() =>
					merge({
						sync: {
							mergePath: syncMerge(definition, settled).mergePath,
							captured: held.commits,
							pinned: (_commits, at) => {
								capturedAt = at;
							},
						},
					}),
				recordMerge,
			);
			if (mergeError !== null)
				switch (mergeError.name) {
					case 'Closed':
						return SyncError.Closed();
					case 'Dirty':
					case 'StagedChanges':
						return SyncError.Stale({ reason: 'changed' });
					case 'BranchMoved':
						if ('filesApplied' in mergeError && !mergeError.filesApplied)
							return SyncError.Stale({ reason: 'changed' });
						return SyncError.Merge({ error: mergeError });
					default:
						return SyncError.Merge({ error: mergeError });
				}
			const head = merged.status === 'merged' ? merged.to : undefined;
			return Ok(await settleSync(head, held.commits.fetched, capturedAt));
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
		current = undefined;
		closing.abort(new Error('The folder is closed'));
		runners = Promise.all([
			pushRunner.close(),
			fetchRunner.close(),
			scanRunner.close(),
		]);
		emit();
	}

	emit();
	// A record or a merge another tab or an earlier opening left is read,
	// never resumed or cleared.
	{
		const read = refreshPending().then(() => {
			if (pendingIncoming !== undefined) emit();
		});
		admittedWork.add(read);
		void read.then(() => admittedWork.delete(read));
	}

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
		/** Commits the folder's current files without pushing. */
		commit: (): Promise<CommitOutcome> => commitNow(),
		async commitAndPush({
			signal,
		}: {
			signal?: AbortSignal;
		} = {}): Promise<CommitAndPushResult> {
			const commit = await until(
				commitNow(),
				signal,
				(): CommitOutcome => ({ status: 'stoppedWaiting' }),
			);
			if (commit.status !== 'committed' && commit.status !== 'unchanged')
				return {
					commit,
					push:
						commit.status === 'stoppedWaiting'
							? { status: 'stoppedWaiting' }
							: { status: 'skipped', reason: 'the commit did not complete' },
				};
			if (backend.remote === undefined)
				return { commit, push: { status: 'noRemote' } };
			// The push is this caller's next step, not the commit's. A caller
			// that stopped waiting starts none; the commit it left still finishes.
			const push = await network(pushRunner, signal, stoppedPush);
			return { commit, push };
		},
		push: ({ signal }: { signal?: AbortSignal } = {}): Promise<PushOutcome> =>
			network(pushRunner, signal, stoppedPush),
		fetch: ({
			signal,
		}: {
			signal?: AbortSignal;
		} = {}): Promise<Result<FetchOutcome, GitError>> =>
			network(fetchRunner, signal, () =>
				GitError.StoppedWaiting({ operation: 'fetch' }),
			),
		pullFastForward: pullNow,
		mergeIncoming: mergeNow,
		recoverIncoming: recoverNow,
		sync: Object.freeze({
			supported: true,
			run: runSync,
			resolve: resolveSync,
		}),
		paths: (): Promise<Result<PathStatus[], GitError>> =>
			guarded('status', () => exclusive(() => backend.pathStatus())),
		async stage(
			paths: readonly string[] | 'all',
		): Promise<Result<undefined, GitError>> {
			if (closing.signal.aborted) return GitError.Closed();
			return manual('add', async () => {
				const staged = await exclusive(
					async (): Promise<Result<undefined, GitError>> => {
						const pending = await backend.pendingIncoming?.();
						if (pending !== undefined)
							return GitError.IncomingPending({ pending });
						await backend.stage(paths);
						return Ok(undefined);
					},
				);
				emit();
				return staged;
			});
		},
		commitStaged(message: string): Promise<Result<StagedCommit, GitError>> {
			if (closing.signal.aborted) return Promise.resolve(GitError.Closed());
			return manual('commit', () => commitStaged(message));
		},
		diff: (options: { staged: boolean; paths: readonly string[] }) =>
			guarded('diff', () => exclusive(() => backend.diff(options))),
		log: (depth: number): Promise<Result<CommitSummary[], GitError>> =>
			guarded('log', () => backend.log(depth)),
		/**
		 * Resolve once nothing of this handle still uses storage: the commits,
		 * pulls, and other Git operations already inside the backend's
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
