/**
 * History coordination for one opened folder (ADR-0468, ADR-0469, ADR-0471).
 *
 * File saves never wait here. A managed save may request a commit; the commit
 * runner keeps one active pass and one pending pass. A pass captures the
 * whole portable folder, writes blobs and trees, writes a commit on the pinned
 * branch head, and moves the branch with a compare-and-swap. It never reads
 * or writes the shared index to build that commit. A moved branch leaves the
 * candidate unreachable and is reported; there is no retry loop.
 *
 * Outgoing pushes have an independent runner. Each attempt pins the commit it
 * pushes. Incoming changes are explicit: `fetch` records the remote head, and
 * `pullFastForward` publishes a clean fast-forward through the file boundary.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { FileBoundary, FileChange } from '../boundary.js';
import { describe, type FileError, type FileStep } from '../errors.js';
import { ancestors, collisionKey, pathProblem } from '../paths.js';
import { captureVersion } from '../version.js';
import type { GitBackend, GitRemote, PathStatus } from './backend.js';
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
	writeCommitObject,
	writeFilesTree,
} from './objects.js';
import { createPassRunner } from './runner.js';
import { sourceFiles } from './scope.js';

export const GitError = defineErrors({
	Failed: ({ operation, cause }: { operation: string; cause: unknown }) => ({
		message: `Git ${operation} failed: ${describe(cause)}`,
		operation,
		cause,
	}),
	Closed: () => ({ message: 'The folder is closed' }),
	NoRemote: () => ({ message: 'No remote is configured for this folder' }),
	StoppedWaiting: ({ operation }: { operation: string }) => ({
		message: `Stopped waiting for Git ${operation}; the shared attempt may still complete`,
		operation,
	}),
	InvalidMessage: ({ reason }: { reason: string }) => ({
		message: `The commit message is not usable: ${reason}`,
		reason,
	}),
	NothingToCommit: () => ({ message: 'Nothing is staged to commit' }),
	BranchMoved: ({
		expected,
		actual,
	}: {
		expected: string | undefined;
		actual: string | undefined;
	}) => ({
		message: 'The branch moved while the commit was being written',
		expected,
		actual,
	}),
});
export type GitError = InferErrors<typeof GitError>;

export const PullError = defineErrors({
	NoFetchedHead: () => ({
		message: 'No fetched remote head is available; fetch first',
	}),
	Blocked: ({ reason }: { reason: string }) => ({
		message: `The folder cannot be updated now: ${reason}`,
		reason,
	}),
	Diverged: ({ head, fetched }: { head: string; fetched: string }) => ({
		message:
			'Local and remote history have diverged; this folder only applies fast-forwards',
		head,
		fetched,
	}),
	Dirty: ({ paths }: { paths: readonly string[] }) => ({
		message: `${paths.length} uncommitted ${paths.length === 1 ? 'change blocks' : 'changes block'} the update`,
		paths,
	}),
	StagedChanges: () => ({
		message: 'Staged changes block the update',
	}),
	Collision: ({ paths }: { paths: readonly string[] }) => ({
		message: `The update would overwrite ${paths.length === 1 ? 'an ignored or untracked file' : `${paths.length} ignored or untracked files`}: ${paths.join(', ')}`,
		paths,
	}),
	Unrepresentable: ({
		paths,
		reason,
	}: {
		paths: readonly string[];
		reason: string;
	}) => ({
		message: `The incoming commit cannot be written to this folder: ${reason}`,
		paths,
		reason,
	}),
	Refused: ({ error }: { error: FileError }) => ({
		message: `A file changed before the update could be written: ${error.message}`,
		error,
	}),
	Partial: ({
		applied,
		error,
	}: {
		applied: readonly FileStep[];
		error: FileError;
	}) => ({
		message: `The update stopped after ${applied.length} file steps; the branch did not move: ${error.message}`,
		applied,
		error,
	}),
	BranchMoved: ({
		actual,
		filesApplied,
	}: {
		actual: string | undefined;
		filesApplied: boolean;
	}) => ({
		message: filesApplied
			? 'Files were updated, but the branch moved before it could be advanced'
			: 'The branch moved before the update could be published; nothing was written',
		actual,
		filesApplied,
	}),
	IndexFailed: ({ error }: { error: string }) => ({
		message: `Files were updated, but the Git index could not be updated; the branch did not move: ${error}`,
		error,
	}),
});
export type PullError = InferErrors<typeof PullError>;

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
	/** The caller's signal aborted; the shared pass may still complete. */
	| { readonly status: 'stoppedWaiting' }
	| { readonly status: 'closed' };

export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'noRemote' }
	| { readonly status: 'nothingToPush' }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string | undefined }
	| { readonly status: 'skipped'; readonly reason: string }
	/** The caller's signal aborted; the shared push may still complete. */
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

export type Activity = { readonly active: boolean; readonly pending: boolean };

export type Attempt<T> = T & { readonly at: number };

export type GitSnapshot = {
	readonly branch: string;
	readonly remote: GitRemote | undefined;
	readonly commitOnEdit: boolean;
	readonly files: Observation<FilesObservation>;
	readonly sync: Observation<SyncObservation>;
	readonly activity: {
		readonly scan: Activity;
		readonly commit: Activity;
		readonly push: Activity;
		readonly fetch: Activity;
		readonly pull: Activity;
	};
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
	readonly lastFetch:
		| Attempt<{ readonly result: Result<FetchOutcome, GitError> }>
		| undefined;
	readonly lastPull:
		| Attempt<{ readonly result: Result<PullOutcome, PullError | GitError> }>
		| undefined;
	readonly closed: boolean;
};

export type CommitAndPushResult = {
	readonly commit: CommitOutcome;
	readonly push: PushOutcome;
};

type CommitPass = {
	readonly outcome: CommitOutcome;
	readonly followingPush: Promise<PushOutcome> | undefined;
};

export type History = ReturnType<typeof createHistory>;

export function createHistory({
	backend,
	boundary,
	author,
	commitOnEdit,
}: {
	backend: GitBackend;
	boundary: FileBoundary;
	author: Author;
	commitOnEdit: boolean;
}) {
	let clock = 0;
	let lastEdit = 0;
	let closing = false;
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
	let remoteSeq = 0;
	/**
	 * Whether the next commit pass was requested by a managed save. Consumed
	 * when a pass starts; only such passes push afterward.
	 */
	let automaticQueued = false;
	/** Explicit status, staging, and staged-commit work that close must drain. */
	const manualWork = new Set<Promise<unknown>>();
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	let snapshot: GitSnapshot;

	function activity(runner: { active: boolean; pending: boolean }): Activity {
		return { active: runner.active, pending: runner.pending };
	}

	function emit() {
		const { capturedAt: _capturedAt, ...publicFiles } =
			files as typeof files & {
				capturedAt?: number;
			};
		snapshot = Object.freeze({
			branch: backend.branch,
			remote: backend.remote,
			commitOnEdit,
			files: publicFiles as Observation<FilesObservation>,
			sync,
			activity: {
				scan: activity(scanRunner),
				commit: activity(commitRunner),
				push: activity(pushRunner),
				fetch: activity(fetchRunner),
				pull: activity(pullRunner),
			},
			lastCommit,
			lastPush,
			lastFetch,
			lastPull,
			closed: closing,
		});
		for (const listener of listeners) listener(snapshot);
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

	async function refreshSync() {
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
		const captured = await boundary.capture();
		if (captured.error) throw new Error(captured.error.message);
		if (captured.data.unreadable.length > 0)
			throw new Error(
				`${captured.data.unreadable.length} files could not be read: ${captured.data.unreadable
					.map((item) => item.path)
					.join(', ')}`,
			);
		return captured.data.files;
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
	 * otherwise invalidate and request a real scan.
	 */
	async function observeCommitted(
		capturedAt: number,
		head: string | undefined,
	) {
		const actual = await backend.readBranch();
		if (actual === head) {
			observeFiles(capturedAt, { head, changes: [] });
			return;
		}
		if (files.state === 'observed') files = { ...files, stale: true };
		if (!closing) void scanRunner.request();
	}

	/** A known file change: existing observations become stale. */
	function markEdited() {
		lastEdit = ++clock;
		if (files.state === 'observed' && !files.stale)
			files = { ...files, stale: true };
	}

	/**
	 * An operation failed after some of its file changes landed. The cached
	 * clean observation no longer describes the folder: mark it stale and ask
	 * for a fresh scan. This requests no commit.
	 */
	function markLanded() {
		markEdited();
		if (!closing) void scanRunner.request();
	}

	const scanRunner = createPassRunner<Result<FilesObservation, GitError>>({
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
		cancelled: () => GitError.Closed(),
		onChange: () => emit(),
	});

	/** Why this folder's history cannot take a whole-folder commit or update now. */
	async function wholeFolderProblem(): Promise<string | undefined> {
		return (await backend.blocked()) ?? (await backend.checkpointProblem());
	}

	async function checkpoint(): Promise<CommitOutcome> {
		return backend.exclusive(async () => {
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return { status: 'blocked', reason: blocked };
			// Pin the parent, then capture, both inside the Git lock. A pull or
			// staged commit that changed files and the branch while this pass
			// waited is part of the capture, so an older capture can never be
			// committed on top of a newer parent. An external branch move after
			// this point still fails the compare-and-swap below.
			const parent = await backend.readBranch();
			const capturedAt = ++clock;
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

	const commitRunner = createPassRunner<CommitPass>({
		async run() {
			const automatic = automaticQueued;
			automaticQueued = false;
			const outcome = await checkpoint().catch(
				(cause): CommitOutcome => ({
					status: 'failed',
					error: describe(cause),
				}),
			);
			lastCommit = { ...outcome, at: Date.now() };
			await refreshSync();
			let followingPush: Promise<PushOutcome> | undefined;
			// Only a pass a managed save requested pushes afterward; an explicit
			// commit stays local, and commits finishing during close do not push.
			if (
				automatic &&
				commitOnEdit &&
				!closing &&
				backend.remote !== undefined &&
				(outcome.status === 'committed' || outcome.status === 'unchanged')
			)
				followingPush = pushRunner.request();
			emit();
			return { outcome, followingPush };
		},
		failed: (cause) => ({
			outcome: { status: 'failed', error: describe(cause) },
			followingPush: undefined,
		}),
		closed: () => ({ outcome: { status: 'closed' }, followingPush: undefined }),
		cancelled: () => ({
			outcome: { status: 'closed' },
			followingPush: undefined,
		}),
		onChange: () => emit(),
	});

	const pushRunner = createPassRunner<PushOutcome>({
		async run(signal) {
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
		cancelled: () => ({ status: 'cancelled', oid: undefined }),
		onChange: () => emit(),
	});

	const fetchRunner = createPassRunner<Result<FetchOutcome, GitError>>({
		async run(signal) {
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
		cancelled: () => GitError.Closed(),
		onChange: () => emit(),
	});

	async function pull(): Promise<Result<PullOutcome, PullError | GitError>> {
		if (backend.remote === undefined) return GitError.NoRemote();
		return backend.exclusive(async () => {
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return PullError.Blocked({ reason: blocked });
			const capturedAt = ++clock;
			const fetched = await backend.readRemoteTracking();
			if (fetched === undefined) return PullError.NoFetchedHead();
			const head = await backend.readBranch();
			if (head === fetched) return Ok({ status: 'upToDate', head });
			if (head !== undefined) {
				const fastForward = await backend.withObjects((access) =>
					isAncestor(access, head, fetched),
				);
				if (!fastForward) {
					const contained = await backend.withObjects((access) =>
						isAncestor(access, fetched, head),
					);
					if (contained) return Ok({ status: 'ahead', head });
					return PullError.Diverged({ head, fetched });
				}
			}
			// The entire folder must be clean, including staged changes.
			const raw = await capture();
			const committed = await headFiles(head);
			const current = await source(raw, committed);
			const dirty = diffFileMaps(committed, await hashFiles(current));
			if (dirty.length > 0)
				return PullError.Dirty({ paths: dirty.map((change) => change.path) });
			if (!(await backend.indexMatchesHead())) return PullError.StagedChanges();

			const incoming = await headFiles(fetched);
			const unsupported = [...incoming]
				.filter(([, entry]) => entry.mode !== '100644')
				.map(([path]) => path);
			if (unsupported.length > 0)
				return PullError.Unrepresentable({
					paths: unsupported,
					reason:
						'symbolic links, submodules, and executable files are not plain folder files',
				});
			const invalid = [...incoming.keys()].filter(
				(path) => pathProblem(path) !== undefined,
			);
			if (invalid.length > 0)
				return PullError.Unrepresentable({
					paths: invalid,
					reason: 'some paths are not valid folder paths',
				});
			const folded = new Map<string, string>();
			for (const path of incoming.keys()) {
				const key = collisionKey(path);
				const existing = folded.get(key);
				if (existing !== undefined)
					return PullError.Unrepresentable({
						paths: [existing, path],
						reason: 'paths collide on case-insensitive filesystems',
					});
				folded.set(key, path);
			}

			const changes = diffFileMaps(committed, incoming);
			// Ignored and untracked files are preserved, never overwritten.
			const rawPaths = [...raw.keys()];
			const colliding = changes
				.filter((change) => change.kind === 'add')
				.map((change) => change.path)
				.filter(
					(path) =>
						raw.has(path) ||
						ancestors(path).some((parent) => raw.has(parent)) ||
						rawPaths.some((existing) => existing.startsWith(`${path}/`)),
				);
			if (colliding.length > 0)
				return PullError.Collision({ paths: colliding });
			const removals: FileChange[] = [];
			const writes: FileChange[] = [];
			for (const change of changes) {
				const bytes = current.get(change.path);
				const expected =
					bytes === undefined
						? ('absent' as const)
						: await captureVersion(bytes);
				if (change.kind === 'delete') {
					removals.push({ kind: 'remove', path: change.path, expected });
					continue;
				}
				const next = await backend.withObjects((access) =>
					readBlob(access, incoming.get(change.path)!.oid),
				);
				writes.push({
					kind: 'write',
					path: change.path,
					bytes: next,
					version: await captureVersion(next),
					expected,
				});
			}
			const published = await backend.publishFastForward({
				expectedHead: head,
				nextHead: fetched,
				changes: [...removals, ...writes],
				paths: changes.map((change) => change.path),
			});
			switch (published.status) {
				case 'published':
					await observeCommitted(capturedAt, fetched);
					return Ok({
						status: 'fastForwarded',
						from: head,
						to: fetched,
						changedPaths: changes.map((change) => change.path),
					});
				case 'refused':
					return PullError.Refused({ error: published.error });
				case 'partial':
					markLanded();
					return PullError.Partial({
						applied: published.applied,
						error: published.error,
					});
				case 'branchMoved':
					if (published.filesApplied) markLanded();
					return PullError.BranchMoved({
						actual: published.actual,
						filesApplied: published.filesApplied,
					});
				case 'indexFailed':
					markLanded();
					return PullError.IndexFailed({ error: published.error });
			}
		});
	}

	const pullRunner = createPassRunner<
		Result<PullOutcome, PullError | GitError>
	>({
		async run() {
			const result = await pull().catch((cause) =>
				GitError.Failed({ operation: 'pull', cause }),
			);
			if (result.error === null || result.error.name !== 'Failed')
				await refreshSync();
			lastPull = { result, at: Date.now() };
			emit();
			return result;
		},
		failed: (cause) => GitError.Failed({ operation: 'pull', cause }),
		closed: () => GitError.Closed(),
		cancelled: () => GitError.Closed(),
		onChange: () => emit(),
	});

	/**
	 * Stop this caller waiting when its signal aborts. Passes are shared by
	 * every requester, so a caller signal never aborts the transport; only
	 * closing the folder does.
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

	/**
	 * Admit one explicit Git operation for its whole lifetime, including any
	 * refresh after the backend call. Refused once closing starts; `close()`
	 * drains admitted work before storage is released.
	 */
	function manual<T>(
		operation: string,
		work: () => Promise<Result<T, GitError>>,
	): Promise<Result<T, GitError>> {
		if (closing) return Promise.resolve(GitError.Closed());
		const running = work().catch((cause) =>
			GitError.Failed({ operation, cause }),
		);
		manualWork.add(running);
		void running.then(() => manualWork.delete(running));
		return running;
	}

	function guarded<T>(
		operation: string,
		work: () => Promise<T>,
	): Promise<Result<T, GitError>> {
		return manual(operation, async () => Ok(await work()));
	}

	async function commitStaged(
		message: string,
	): Promise<Result<{ oid: string; parent: string | undefined }, GitError>> {
		const problem = messageProblem(message);
		if (problem !== undefined)
			return GitError.InvalidMessage({ reason: problem });
		const blocked = await backend.blocked();
		if (blocked !== undefined)
			return GitError.Failed({ operation: 'commit', cause: blocked });
		let changedPaths = 0;
		let result: Awaited<ReturnType<GitBackend['commitIndex']>>;
		try {
			result = await backend.exclusive(async () => {
				changedPaths = (await backend.pathStatus()).filter(
					(path) => path.index !== ' ' && path.index !== '?',
				).length;
				return backend.commitIndex(message, author);
			});
		} catch (cause) {
			return GitError.Failed({ operation: 'commit', cause });
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
			case 'nothing':
				return GitError.NothingToCommit();
			case 'branchMoved':
				return GitError.BranchMoved({
					expected: undefined,
					actual: result.actual,
				});
			case 'committed':
				return Ok({ oid: result.oid, parent: result.parent });
		}
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
		/**
		 * The implicit request after a managed save; never awaited by the save.
		 * The pass it starts or joins pushes afterward when a remote exists.
		 */
		requestAutomaticCommit() {
			if (!commitOnEdit || closing) return;
			automaticQueued = true;
			void commitRunner.request();
		},
		status: () => scanRunner.request(),
		async commit(): Promise<CommitOutcome> {
			return (await commitRunner.request()).outcome;
		},
		async commitAndPush({
			signal,
		}: {
			signal?: AbortSignal;
		} = {}): Promise<CommitAndPushResult> {
			const stoppedCommit = (): CommitPass => ({
				outcome: { status: 'stoppedWaiting' },
				followingPush: undefined,
			});
			const pass = await until(commitRunner.request(), signal, stoppedCommit);
			const commit = pass.outcome;
			if (commit.status !== 'committed' && commit.status !== 'unchanged')
				return {
					commit,
					push: { status: 'skipped', reason: 'the commit did not complete' },
				};
			if (backend.remote === undefined)
				return { commit, push: { status: 'noRemote' } };
			const push = await until(
				pass.followingPush ?? pushRunner.request(),
				signal,
				(): PushOutcome => ({ status: 'stoppedWaiting' }),
			);
			return { commit, push };
		},
		push({ signal }: { signal?: AbortSignal } = {}): Promise<PushOutcome> {
			return until(pushRunner.request(), signal, () => ({
				status: 'stoppedWaiting',
			}));
		},
		fetch({ signal }: { signal?: AbortSignal } = {}) {
			return until(fetchRunner.request(), signal, () =>
				GitError.StoppedWaiting({ operation: 'fetch' }),
			);
		},
		pullFastForward: () => pullRunner.request(),
		paths: (): Promise<Result<PathStatus[], GitError>> =>
			guarded('status', () => backend.exclusive(() => backend.pathStatus())),
		async stage(
			paths: readonly string[] | 'all',
		): Promise<Result<undefined, GitError>> {
			const result = await guarded('add', () =>
				backend.exclusive(() => backend.stage(paths)),
			);
			if (result.error === null) return Ok(undefined);
			return result;
		},
		commitStaged(
			message: string,
		): Promise<Result<{ oid: string; parent: string | undefined }, GitError>> {
			return manual('commit', () => commitStaged(message));
		},
		diff: (options: { staged: boolean; paths: readonly string[] }) =>
			guarded('diff', () => backend.exclusive(() => backend.diff(options))),
		log: (depth: number): Promise<Result<CommitSummary[], GitError>> =>
			guarded('log', () => backend.log(depth)),
		/**
		 * Fence new requests, then synchronously cancel queued pushes and
		 * fetches and abort the active transport before waiting on anything.
		 * Admitted local passes and explicit Git operations drain. Resolves
		 * only when all of them settled.
		 */
		close(): Promise<void> {
			closed ??= (async () => {
				closing = true;
				const network = Promise.all([
					pushRunner.close('cancel'),
					fetchRunner.close('cancel'),
				]);
				const local = Promise.all([
					commitRunner.close('drain'),
					scanRunner.close('drain'),
					pullRunner.close('drain'),
					Promise.allSettled([...manualWork]),
				]);
				emit();
				await Promise.all([network, local]);
				emit();
			})();
			return closed;
		},
	};
}
