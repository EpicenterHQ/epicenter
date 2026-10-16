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
 * files one guarded write at a time, the live file as the writer acting, so
 * text typed while Sync runs stands. A journal names each publish before it
 * starts, and every commit and Sync finishes a journal it finds first.
 *
 * Status scans take no protection. Callers who ask while a scan is running
 * share the one scan that follows it, so a burst of requests costs two scans
 * and the last one reads the folder after every request was made.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileBoundary } from '../boundary.js';
import { hashBytes } from '../capture.js';
import type { FolderDefinition } from '../definition.js';
import { describe, UnconfirmedWrite } from '../errors.js';
import { callObserver } from '../observer.js';
import { fileKindOf, merge, sameContent } from '../merge-file.js';
import { ancestors, collisionKey, pathProblem } from '../paths.js';
import { confirmedPut } from '../save-file.js';
import type { GitBackend, GitRemote } from './backend.js';
import { GitError, SyncError } from './errors.js';
import { chooseBase, mergeHistories, mergeMessage } from './merge.js';
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
import { createPassRunner } from './runner.js';
import { localMatcher, sourceFiles } from './scope.js';
import type { SyncOptions, SyncOutcome } from './sync.js';

export { GitError };

const encoder = new TextEncoder();

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

/** What Sync's push of one commit did. */
export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string };

export type FetchOutcome = {
	readonly status: 'fetched';
	/** The remote branch head, or undefined when the remote has no such branch. */
	readonly oid: string | undefined;
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
	};
	readonly lastCommit: Attempt<CommitOutcome> | undefined;
	readonly lastPush: Attempt<PushOutcome> | undefined;
	readonly lastFetch:
		| Attempt<{ readonly result: Result<FetchOutcome, GitError> }>
		| undefined;
	readonly closed: boolean;
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
	/** Paths a Sync wrote or removed, whether or not it completed. */
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
	let lastFetch: GitSnapshot['lastFetch'];
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
				push: { active: running.push > 0 },
				fetch: { active: fetchRunner.active },
			},
			lastCommit,
			lastPush,
			lastFetch,
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

	/**
	 * Files the definition keeps on this machine. No commit carries one,
	 * whether or not `.gitignore` names it (ADR-0577).
	 */
	const isLocal = localMatcher(definition?.local);

	/** Captured files that are history source under the shared scope rule. */
	function source(
		current: ReadonlyMap<string, Uint8Array>,
		tracked: ReadonlyMap<string, unknown>,
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
		},
	);

	/** Why this folder's history cannot take a whole-folder commit or update now. */
	async function wholeFolderProblem(): Promise<string | undefined> {
		return (await backend.blocked()) ?? (await backend.checkpointProblem());
	}

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
		const blocked = await wholeFolderProblem();
		if (blocked !== undefined) return { status: 'blocked', reason: blocked };
		// A Sync that stopped while it wrote its files is finished first, so
		// what it wrote is never recorded as this device's edits (ADR-0576).
		const unfinished = await finishJournal();
		if (unfinished !== undefined)
			return { status: 'blocked', reason: unfinished };
		// Pin the parent, then capture, both inside the backend's
		// protection. A pull or staged commit of this handle that changed
		// files and the branch while this pass waited is part of the
		// capture, so an older capture can never be committed on top of a
		// newer parent. A branch move from outside the protection after
		// this point fails the compare-and-swap below.
		const parent = await backend.readBranch();
		const capturedAt = ++clock;
		onCapture?.(capturedAt);
		const current = await capture();
		const committed = await headFiles(parent);
		const included = await source(current, committed);
		// An empty folder with no history has nothing to record, and writes
		// nothing: not even an empty tree.
		const built =
			parent === undefined && included.size === 0
				? undefined
				: await backend.withObjects(async (access) => {
						const tree = await writeFilesTree(access, included);
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
		subject?: string,
	): Promise<CommitOutcome> {
		if (closing.signal.aborted) return Promise.resolve({ status: 'closed' });
		if (subject !== undefined) {
			const problem = messageProblem(subject);
			if (problem !== undefined)
				return Promise.resolve({ status: 'failed', error: problem });
		}
		return owned('commit', async (): Promise<CommitOutcome> => {
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
		});
	}

	const fetchRunner = createPassRunner<void, Result<FetchOutcome, GitError>>({
		async run(_input, signal) {
			if ((await backend.refreshRemote()) === undefined)
				return GitError.NoRemote();
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

	/**
	 * Refuse a tree, the files of `commit`, that this folder cannot write as
	 * plain bytes: a link, an executable, a submodule, an invalid path, a Git
	 * attribute filter, or two paths only their case tells apart.
	 */
	async function representable(
		commit: string,
	): Promise<Result<undefined, SyncError>> {
		const files = await headFiles(commit);
		const unsupported = [...files]
			.filter(([, entry]) => entry.mode !== '100644')
			.map(([path]) => path);
		if (unsupported.length > 0)
			return SyncError.Unrepresentable({
				paths: unsupported,
				reason:
					'symbolic links, submodules, and executable files are not plain folder files',
			});
		const invalid = [...files.keys()].filter(
			(path) => pathProblem(path) !== undefined,
		);
		if (invalid.length > 0)
			return SyncError.Unrepresentable({
				paths: invalid,
				reason: 'some paths are not valid folder paths',
			});
		// A commit that declares a filter or a conversion for a path means
		// something else by its bytes: under `filter=lfs` a blob is a pointer.
		const declared = await backend.incomingAttribute(commit, files);
		if (declared !== undefined)
			return SyncError.Unrepresentable({
				paths: [declared.path],
				reason: `the commit declares the Git attribute ${declared.attribute}, and this folder does not apply attribute filters or conversion`,
			});
		const folded = new Map<string, string>();
		for (const path of files.keys()) {
			const key = collisionKey(path);
			const existing = folded.get(key);
			if (existing !== undefined)
				return SyncError.Unrepresentable({
					paths: [existing, path],
					reason: 'paths collide on case-insensitive filesystems',
				});
			folded.set(key, path);
		}
		return Ok(undefined);
	}

	/** How each path merges, by the definition this handle reads with. */
	const kindOf = (path: string) => fileKindOf(definition, path);

	/**
	 * Sync's journal (ADR-0576): a publish of `to` over the files the branch
	 * left at `from`, written before its first put and removed when it is done.
	 */
	type Journal = {
		readonly version: 1;
		readonly branch: string;
		readonly from: string | null;
		readonly to: string;
	};
	const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

	/** The journal, `undefined` with none, or `unreadable`. */
	async function readJournal(): Promise<Journal | 'unreadable' | undefined> {
		const text = await backend.readJournal();
		if (text === undefined) return undefined;
		try {
			const value = JSON.parse(text) as Partial<Journal>;
			if (
				value.version !== 1 ||
				typeof value.to !== 'string' ||
				!OID.test(value.to) ||
				(value.from !== null &&
					(typeof value.from !== 'string' || !OID.test(value.from)))
			)
				return 'unreadable';
			return value as Journal;
		} catch {
			return 'unreadable';
		}
	}

	/** How many times one file is written again when it changes under Sync. */
	const PUBLISH_ATTEMPTS = 10;

	/**
	 * Inside the protection: write the tree of `to` over the files, which the
	 * branch left at `from`, then set the index to it and move the branch.
	 * Each path that differs between the two goes once, local paths aside
	 * (ADR-0577): a live file that still holds `from`'s bytes takes `to`'s,
	 * and one changed since takes `merge(base: from, ours: live, theirs: to)`,
	 * the live file as the writer acting. Every put is guarded by the live
	 * file's hash and done again when it is stale. Removals go first, and
	 * each removal's emptied directories after it, so a file can take a
	 * directory's place and the reverse. A file of this folder's own where
	 * `to` needs a directory, or files where it needs a file, refuse the
	 * publish before anything is written. Returns the paths it changed.
	 */
	async function publish(
		from: string | undefined,
		to: string,
	): Promise<Result<readonly string[], SyncError>> {
		const [before, after] = await Promise.all([headFiles(from), headFiles(to)]);
		const changes = diffFileMaps(before, after).filter(
			(change) => !isLocal(change.path),
		);
		const { data: listed, error: listError } = await boundary.list();
		if (listError !== null)
			return SyncError.Publish({ path: '', error: listError.message });
		const leaving = new Set(
			changes
				.filter((change) => change.kind === 'delete')
				.map((change) => change.path),
		);
		const staying = listed.files
			.map(({ path }) => path)
			.filter((path) => !leaving.has(path));
		const stayingSet = new Set(staying);
		const inTheWay = changes
			.filter((change) => change.kind !== 'delete')
			.map((change) => change.path)
			.filter(
				(path) =>
					ancestors(path).some((ancestor) => stayingSet.has(ancestor)) ||
					staying.some((other) => other.startsWith(`${path}/`)),
			);
		if (inTheWay.length > 0)
			return SyncError.Blocked({
				reason: `files of this folder stand where the remote has ${inTheWay.map((path) => `'${path}'`).join(', ')}; move them, then sync again`,
			});
		const journal: Journal = {
			version: 1,
			branch: backend.branch,
			from: from ?? null,
			to,
		};
		await backend.writeJournal(JSON.stringify(journal));
		const ordered = [
			...changes.filter((change) => change.kind === 'delete'),
			...changes.filter((change) => change.kind !== 'delete'),
		];
		const blob = (entry: TreeFile | undefined) =>
			entry === undefined
				? Promise.resolve(null)
				: backend.withObjects((access) => readBlob(access, entry.oid));
		const reached: string[] = [];
		let kept = false;
		try {
			for (const { path, kind } of ordered) {
				const [was, next] = await Promise.all([
					blob(before.get(path)),
					blob(after.get(path)),
				]);
				let done = false;
				for (let attempt = 0; attempt < PUBLISH_ATTEMPTS && !done; attempt++) {
					const read = await boundary.read(path);
					if (read.error !== null && read.error.name !== 'NotFound')
						return SyncError.Publish({ path, error: read.error.message });
					const live = read.error === null ? read.data : undefined;
					const liveBytes = live?.bytes ?? null;
					const edited = !sameContent(liveBytes, was);
					const merged = !edited
						? next
						: (
								await merge(kindOf(path), {
									base: was,
									ours: liveBytes,
									theirs: next,
								})
							).content;
					const target =
						typeof merged === 'string' ? encoder.encode(merged) : merged;
					if (sameContent(target, liveBytes)) {
						kept ||= edited && !sameContent(liveBytes, next);
						done = true;
						break;
					}
					const put = await confirmedPut(
						boundary,
						path,
						target,
						live?.sha256 ?? null,
						target === null ? null : await hashBytes(target),
					);
					if (put.error !== null)
						return SyncError.Publish({ path, error: put.error.message });
					done = put.data === 'landed';
					if (done) kept ||= edited && !sameContent(target, next);
				}
				if (!done)
					return SyncError.Publish({
						path,
						error: 'it kept changing while Sync wrote it',
					});
				reached.push(path);
				if (kind === 'delete')
					for (const directory of ancestors(path).reverse())
						if ((await boundary.rmdir(directory)).error !== null) break;
			}
		} finally {
			if (reached.length > 0) {
				markLanded(kept);
				landed(reached);
			}
		}
		await backend.reconcileIndex(to);
		const moved = await backend.casBranch(from, to);
		if (!moved.ok)
			return SyncError.Blocked({
				reason: `the branch moved to ${moved.actual ?? 'no commit'} while Sync wrote its files`,
			});
		const now = await readJournal();
		if (now !== undefined && now !== 'unreadable' && now.to === to)
			await backend.removeJournal();
		return Ok(reached);
	}

	/**
	 * Inside the protection: finish a publish a journal names, before
	 * anything else changes the branch or records files. With the branch at
	 * its `to`, only the index and the journal are left; at its `from`, the
	 * publish runs again. Answers why it cannot be finished.
	 */
	async function finishJournal(): Promise<string | undefined> {
		const journal = await readJournal();
		if (journal === undefined) return undefined;
		if (journal === 'unreadable')
			return 'its Sync journal (.git/epicenter/sync-journal.json) cannot be read';
		const head = await backend.readBranch();
		if (head === journal.to) {
			await backend.reconcileIndex(journal.to);
			await backend.removeJournal();
			return undefined;
		}
		if (head !== (journal.from ?? undefined))
			return `a Sync to ${journal.to} did not finish, and the branch has moved to ${head ?? 'no commit'} since`;
		const { error } = await publish(journal.from ?? undefined, journal.to);
		return error?.message;
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
	 * Inside the protection: publish `to` over the files the branch left at
	 * `from`, or answer the branch's new head when a commit moved it since,
	 * so Sync merges from there.
	 */
	function publishFrom(
		from: string | undefined,
		to: string,
	): Promise<Result<{ moved: string | undefined } | undefined, SyncError>> {
		return exclusive(async () => {
			const blocked = await wholeFolderProblem();
			if (blocked !== undefined) return SyncError.Blocked({ reason: blocked });
			const head = await backend.readBranch();
			if (head !== from) return Ok({ moved: head });
			const { error } = await publish(from, to);
			return error === null ? Ok(undefined) : Err(error);
		});
	}

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
			// The remote head the last push was rejected against: a remote
			// that refused without moving refused for another reason.
			let rejectedAt: string | undefined;
			for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
				const { data: fetched, error: fetchError } =
					await fetchRunner.request();
				if (fetchError !== null)
					return fetchError.name === 'Closed'
						? SyncError.Closed()
						: SyncError.Fetch({ error: fetchError });
				const theirs = fetched.oid;
				if (rejectedAt !== undefined && theirs === rejectedAt)
					return SyncError.Failed({
						cause: new Error(
							'the remote refused the push, and its branch has not moved',
						),
					});
				rejectedAt = undefined;
				if (theirs === local) return done(local, undefined);
				if (
					theirs === undefined ||
					(local !== undefined &&
						(await backend.withObjects((access) =>
							isAncestor(access, theirs, local!),
						)))
				) {
					// The remote is behind: send ours.
					const pushed = await pushCommit(local!);
					if (pushed === 'rejected') {
						rejectedAt = theirs;
						continue;
					}
					return done(local, pushed);
				}
				const refused = await representable(theirs);
				if (refused.error !== null) return refused;
				if (
					local === undefined ||
					(await backend.withObjects((access) =>
						isAncestor(access, local!, theirs),
					))
				) {
					// This folder is behind: take theirs.
					const { data: moved, error } = await publishFrom(local, theirs);
					if (error !== null) return Err(error);
					if (moved !== undefined) {
						local = moved.moved;
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
						kindOf,
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
				const pushed = await pushCommit(merged);
				// Nothing here changed, so merging again from `local` is safe.
				if (pushed === 'rejected') {
					rejectedAt = theirs;
					continue;
				}
				const { data: moved, error } = await publishFrom(mine, merged);
				if (error !== null) return Err(error);
				// A commit moved the branch while the merge was pushed: the next
				// Sync merges the two.
				if (moved !== undefined) return done(moved.moved, pushed);
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
