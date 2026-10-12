/**
 * The desktop adapter: a folder owned by the desktop shell.
 *
 * The shell's Rust side holds the directory: it publishes files, records Git
 * history, and shares one owner between every window. This adapter attaches a
 * page to a folder the shell registered and returns the same folder handle the
 * browser opener returns. The page names the folder's ID and nothing else; the
 * root, the author, the remote, and the commit policy are the shell's, and
 * `browser` options do not apply here.
 *
 * This module exports the opener alone. `tauri.ts` is the public entry; the
 * automatic entry loads this module directly.
 *
 * Outside the desktop app this adapter refuses. Inside it, a missing plugin, a
 * window without permission, an unknown folder, or another protocol version
 * is returned as the refusal it is. Nothing here opens browser storage.
 *
 * Closing the handle detaches this page. File operations return their own
 * outcomes. Detaching leaves the native owner and its coalesced automatic
 * requests alive for other windows. Owner shutdown cancels waiting requests
 * and drains checkpoints already inside protection; it makes no final commit.
 *
 * Nothing holds the folder between two commands. The terminal is the same
 * one every folder has: each step is an ordinary command, other windows'
 * saves land between its steps, and a rewrite of a file it read is refused
 * if the file changed since.
 *
 * An `invoke` that fails after it was sent leaves the outcome unknown. Reads
 * report that as an ordinary failure. Anything that could have changed files
 * or history reports `Unconfirmed` and is never retried here.
 *
 * Saves are not ordered by when their methods were called. Whichever lands
 * last on a path stays, from any handle, page, or window, and a delivery
 * Tauri sends again lands again. Each change's own condition still holds
 * where the owner publishes it.
 *
 * A fast-forward or merge that stops partway leaves the owner's incoming
 * record (ADR-0474). The snapshot reports it as `pendingIncoming`; until it
 * is settled, commits and new updates are refused and saves
 * continue. `recoverIncoming()` is the only way it is resumed, and the owner
 * decides from what the folder holds then.
 *
 * The owner merges like every other folder: `mergeIncoming` sends one
 * command, and a conflict is refused with nothing written. A merge a
 * person's own Git began blocks commits and incoming updates until Git
 * outside Epicenter finishes or aborts it.
 *
 * This module loads no Git implementation and no browser storage.
 */

import { isTauri } from '@tauri-apps/api/core';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileChange, FileRead, FolderStorage } from './boundary.js';
import type { OpenFolder } from './contract.js';
import { prepareFolderDefinition } from './definition.js';
import {
	ApplyError,
	describe,
	FileError,
	type FileStep,
	OpenFolderError,
} from './errors.js';
import {
	assembleFolder,
	createFileHints,
	type FileHints,
	type FolderHistory,
} from './folder.js';
import type {
	PendingIncoming,
	RecordedIncoming,
	StatusCode,
} from './git/backend.js';
import {
	type ConflictVersion,
	GitError,
	type MergeConflict,
	MergeError,
	PullError,
	SyncError,
} from './git/errors.js';
import type {
	CommitOutcome,
	FetchOutcome,
	GitSnapshot,
	MergeOutcome,
	PullOutcome,
	PushOutcome,
	RecoverOutcome,
} from './git/history.js';
import {
	commands,
	events,
	FOLDER_PROTOCOL,
	type ApplyError as WireApplyError,
	type CommitOutcome as WireCommitOutcome,
	type ConflictVersion as WireConflictVersion,
	type FileChange as WireFileChange,
	type FileError as WireFileError,
	type FileStep as WireFileStep,
	type GitError as WireGitError,
	type GitSnapshot as WireGitSnapshot,
	type MergeConflict as WireMergeConflict,
	type MergeError as WireMergeError,
	type MergeOutcome as WireMergeOutcome,
	type PendingIncoming as WirePendingIncoming,
	type PullError as WirePullError,
	type PullOutcome as WirePullOutcome,
	type PushOutcome as WirePushOutcome,
	type RecoverOutcome as WireRecoverOutcome,
} from './native/bindings.gen.js';
import { callObserver } from './observer.js';
import { publishDefinition } from './publish-definition.js';

type Wire<T, E> = { data: T; error: null } | { data: null; error: E };

/** A settled command, or the reason no reply arrived. */
type Reply<T, E> =
	| { readonly sent: true; readonly settled: 'done'; readonly data: T }
	| { readonly sent: true; readonly settled: 'refused'; readonly error: E }
	| { readonly sent: false; readonly cause: unknown };

/** The generated commands throw only when the transport itself fails. */
async function call<W extends Wire<unknown, unknown>>(
	request: Promise<W>,
): Promise<
	Reply<Extract<W, { error: null }>['data'], NonNullable<W['error']>>
> {
	try {
		const { data: reply, error: replyError } = await request;
		// Tauri also rejects with strings for missing commands or permissions.
		// Generated bindings cast every non-Error rejection to the Rust error
		// type; a primitive is not an acknowledged domain refusal.
		if (
			replyError !== null &&
			(typeof replyError !== 'object' || !('name' in replyError))
		)
			return { sent: false, cause: replyError };
		return replyError === null
			? { sent: true, settled: 'done', data: reply }
			: {
					sent: true,
					settled: 'refused',
					error: replyError as NonNullable<W['error']>,
				};
	} catch (cause) {
		return { sent: false, cause };
	}
}

const orUndefined = <T>(value: T | null): T | undefined =>
	value === null ? undefined : value;

function fileError(error: WireFileError): FileError {
	switch (error.name) {
		case 'InvalidPath':
			return FileError.InvalidPath(error).error;
		case 'NotFound':
			return FileError.NotFound(error).error;
		case 'Exists':
			return FileError.Exists(error).error;
		case 'Conflict':
			return FileError.Conflict({
				path: error.path,
				expectedSha256: error.expectedSha256,
				actualSha256: orUndefined(error.actualSha256),
			}).error;
		case 'NotAFile':
			return FileError.NotAFile(error).error;
		case 'NotADirectory':
			return FileError.NotADirectory(error).error;
		case 'DirectoryNotEmpty':
			return FileError.DirectoryNotEmpty(error).error;
		case 'Io':
			return FileError.Io(error).error;
		case 'Closed':
			return FileError.Closed().error;
		case 'Unconfirmed':
			return FileError.Unconfirmed(error).error;
		// A refusal before any write: the session the call named is not one
		// the owner accepts.
		case 'Denied':
			return FileError.Io({
				path: '',
				operation: 'reach the folder for',
				cause: error.reason,
			}).error;
	}
}

function applyError(error: WireApplyError): FileError | ApplyError {
	if (error.name === 'Refused') return fileError(error.error);
	if (error.name === 'Unconfirmed') return FileError.Unconfirmed(error).error;
	return ApplyError.Partial({
		applied: error.applied as FileStep[],
		failed: error.failed as FileStep,
		error: fileError(error.error),
		notAttempted: error.notAttempted as FileStep[],
	}).error;
}

function gitError(error: WireGitError, operation: string): GitError {
	switch (error.name) {
		case 'Unconfirmed':
			return GitError.Unconfirmed(error).error;
		case 'Failed':
			return GitError.Failed(error).error;
		case 'Closed':
			return GitError.Closed().error;
		// The owner started nothing for a caller that had withdrawn.
		case 'Withdrawn':
			return GitError.StoppedWaiting({ operation }).error;
		case 'Denied':
			return GitError.Failed({ operation, cause: error.reason }).error;
		case 'NoRemote':
			return GitError.NoRemote().error;
	}
}

/** The owner's incoming record, as the shared history names it. */
function pendingFromWire(pending: WirePendingIncoming): PendingIncoming {
	return pending.state === 'recorded'
		? recordedFromWire(pending)
		: Object.freeze({ state: 'unreadable', reason: pending.reason });
}

function recordedFromWire(
	pending: Extract<WirePendingIncoming, { state: 'recorded' }>,
): RecordedIncoming {
	return Object.freeze({
		state: 'recorded',
		operationId: pending.operationId,
		branch: pending.branch,
		expectedHead: orUndefined(pending.expectedHead),
		nextHead: pending.nextHead,
	});
}

/** The owner's conflicts already have the shared shape. */
const conflictsFromWire = (
	conflicts: readonly WireMergeConflict[],
): readonly MergeConflict[] => conflicts;

function mergeError(error: WireMergeError): MergeError | PullError | GitError {
	switch (error.name) {
		case 'Pull':
			return pullError(error.error);
		case 'UnsupportedHistory':
			return MergeError.UnsupportedHistory(error).error;
		case 'Unmergeable':
			return MergeError.Unmergeable(error).error;
		case 'Conflicted':
			return MergeError.Conflicted({
				conflicts: conflictsFromWire(error.conflicts),
				// Absent unless asked for, as every folder reports it.
				...(error.versions === null || error.versions === undefined
					? {}
					: { versions: error.versions.map(versionFromWire) }),
			}).error;
	}
}

/** The owner sends bytes as number arrays; every folder hands out `Uint8Array`. */
function versionFromWire(version: WireConflictVersion): ConflictVersion {
	return {
		path: version.path,
		ours: version.ours === null ? null : Uint8Array.from(version.ours),
		theirs: version.theirs === null ? null : Uint8Array.from(version.theirs),
	};
}

function mergeOutcome(outcome: WireMergeOutcome): MergeOutcome {
	switch (outcome.status) {
		case 'upToDate':
		case 'ahead':
		case 'fastForwarded':
			return pullOutcome(outcome);
		case 'merged':
			return outcome;
	}
}

/** A settled recovery. A cleared or completed one names the record it settled. */
function recoverOutcome(
	outcome: WireRecoverOutcome,
): Result<RecoverOutcome, GitError> {
	if (outcome.status === 'none') return Ok({ status: 'none' });
	if (outcome.pending.state !== 'recorded')
		return GitError.Failed({
			operation: 'recover',
			cause: 'the folder host settled an incoming update without its record',
		});
	const pending = recordedFromWire(outcome.pending);
	return outcome.status === 'cleared'
		? Ok({ status: 'cleared', pending })
		: Ok({ status: 'completed', pending, changedPaths: outcome.changedPaths });
}

function pullError(error: WirePullError): PullError | GitError {
	switch (error.name) {
		case 'Git':
			return gitError(error.error, 'pull');
		case 'NoFetchedHead':
			return PullError.NoFetchedHead().error;
		case 'Blocked':
			return PullError.Blocked(error).error;
		case 'Diverged':
			return PullError.Diverged(error).error;
		case 'Dirty':
			return PullError.Dirty(error).error;
		case 'StagedChanges':
			return PullError.StagedChanges().error;
		case 'Collision':
			return PullError.Collision(error).error;
		case 'Unrepresentable':
			return PullError.Unrepresentable(error).error;
		case 'Refused':
			return PullError.Refused({ error: fileError(error.error) }).error;
		case 'Partial':
			return PullError.Partial({
				applied: error.applied as WireFileStep[] as FileStep[],
				error: fileError(error.error),
			}).error;
		case 'BranchMoved':
			return PullError.BranchMoved({
				actual: orUndefined(error.actual),
				filesApplied: error.filesApplied,
			}).error;
		case 'IndexFailed':
			return PullError.IndexFailed(error).error;
		// The record stays; only an explicit recovery decides what happened.
		case 'Unconfirmed':
			return PullError.Unconfirmed({
				applied: error.applied as WireFileStep[] as FileStep[],
				uncertain: error.uncertain,
				error: error.error,
			}).error;
		case 'IncomingPending':
			return PullError.IncomingPending({
				pending: pendingFromWire(error.pending),
			}).error;
		case 'RecoveryRefused':
			return PullError.RecoveryRefused({
				pending: pendingFromWire(error.pending),
				paths: error.paths,
				reason: error.reason,
			}).error;
	}
}

function commitOutcome(outcome: WireCommitOutcome): CommitOutcome {
	switch (outcome.status) {
		case 'committed':
			return {
				...outcome,
				parent: orUndefined(outcome.parent),
				indexWarning: orUndefined(outcome.indexWarning),
			};
		case 'unchanged':
			return {
				status: 'unchanged',
				head: orUndefined(outcome.head),
				indexWarning: orUndefined(outcome.indexWarning),
			};
		case 'branchMoved':
			return {
				status: 'branchMoved',
				candidate: outcome.candidate,
				expected: orUndefined(outcome.expected),
				actual: orUndefined(outcome.actual),
			};
		default:
			return outcome;
	}
}

function pushOutcome(outcome: WirePushOutcome): PushOutcome {
	if (outcome.status === 'cancelled')
		return { status: 'cancelled', oid: orUndefined(outcome.oid) };
	return outcome;
}

function pullOutcome(outcome: WirePullOutcome): PullOutcome {
	switch (outcome.status) {
		case 'upToDate':
			return { status: 'upToDate', head: orUndefined(outcome.head) };
		case 'ahead':
			return outcome;
		case 'fastForwarded':
			return { ...outcome, from: orUndefined(outcome.from) };
	}
}

function observation<W, T>(
	observed: WireObservation<W>,
	value: (wire: W) => T,
): Observed<T> {
	if (observed.state === 'unknown')
		return { state: 'unknown', error: orUndefined(observed.error) };
	return {
		state: 'observed',
		value: value(observed.value),
		checkedAt: observed.checkedAt,
		stale: observed.stale,
		error: orUndefined(observed.error),
	};
}

type WireObservation<W> =
	| { state: 'unknown'; error: string | null }
	| {
			state: 'observed';
			value: W;
			checkedAt: number;
			stale: boolean;
			error: string | null;
	  };

type Observed<T> =
	| { readonly state: 'unknown'; readonly error: string | undefined }
	| {
			readonly state: 'observed';
			readonly value: T;
			readonly checkedAt: number;
			readonly stale: boolean;
			readonly error: string | undefined;
	  };

function snapshotFromWire(wire: WireGitSnapshot): GitSnapshot {
	return Object.freeze({
		branch: wire.branch,
		remote: orUndefined(wire.remote),
		files: observation(wire.files, (files) => ({
			head: orUndefined(files.head),
			changes: files.changes,
		})),
		sync: observation(wire.sync, (sync) => ({
			head: orUndefined(sync.head),
			remote: orUndefined(sync.remote),
			ahead: sync.ahead,
			behind: sync.behind,
		})),
		activity: wire.activity,
		lastCommit:
			wire.lastCommit === null
				? undefined
				: { ...commitOutcome(wire.lastCommit.result), at: wire.lastCommit.at },
		lastPush:
			wire.lastPush === null
				? undefined
				: { ...pushOutcome(wire.lastPush.result), at: wire.lastPush.at },
		lastFetch:
			wire.lastFetch === null
				? undefined
				: {
						at: wire.lastFetch.at,
						result:
							wire.lastFetch.result.status === 'ok'
								? Ok({
										status: 'fetched' as const,
										oid: orUndefined(wire.lastFetch.result.value.oid),
									})
								: Err(gitError(wire.lastFetch.result.error, 'fetch')),
					},
		lastPull:
			wire.lastPull === null
				? undefined
				: {
						at: wire.lastPull.at,
						result:
							wire.lastPull.result.status === 'ok'
								? Ok(pullOutcome(wire.lastPull.result.value))
								: Err(pullError(wire.lastPull.result.error)),
					},
		lastMerge:
			wire.lastMerge === null
				? undefined
				: {
						at: wire.lastMerge.at,
						result:
							wire.lastMerge.result.status === 'ok'
								? Ok(mergeOutcome(wire.lastMerge.result.value))
								: Err(mergeError(wire.lastMerge.result.error)),
					},
		// Absent where none is pending, as the shared snapshot has it.
		...(wire.pendingIncoming === null
			? {}
			: { pendingIncoming: pendingFromWire(wire.pendingIncoming) }),
		closed: wire.closed,
	});
}

/** JavaScript's own string order, which the browser store lists in. */
const sorted = (names: readonly string[]) => [...names].sort();

function changeToWire(change: FileChange): WireFileChange {
	switch (change.kind) {
		case 'create':
		case 'overwrite':
			return {
				kind: change.kind,
				path: change.path,
				bytes: Array.from(change.bytes),
			};
		case 'replace':
			return {
				kind: 'replace',
				path: change.path,
				bytes: Array.from(change.bytes),
				expectedSha256: change.expectedSha256 ?? null,
			};
		case 'remove':
			return {
				kind: 'remove',
				path: change.path,
				expectedSha256: change.expectedSha256 ?? null,
			};
		case 'move':
			return {
				kind: 'move',
				from: change.from,
				to: change.to,
				expectedSha256: change.expectedSha256 ?? null,
			};
	}
}

const stepPaths = (step: FileStep | FileChange): string[] =>
	step.kind === 'move' ? [step.from, step.to] : [step.path];

/**
 * The paths a save may have changed. A definite refusal changed none. A hint
 * asks listeners to reread; it confirms nothing.
 */
function mayHaveChanged(
	changes: readonly FileChange[],
	error: FileError | ApplyError | null,
): string[] {
	if (error === null || error.name === 'Unconfirmed')
		return changes.flatMap(stepPaths);
	if (error.name !== 'Partial') return [];
	return [
		...error.applied.flatMap(stepPaths),
		...(error.error.name === 'Unconfirmed' ? stepPaths(error.failed) : []),
	];
}

function createBoundary(session: number, hints: FileHints): FolderStorage {
	const unsent = (path: string, operation: string, cause: unknown) =>
		FileError.Io({ path, operation, cause });

	const toRead = (read: {
		bytes: number[];
		sha256: FileRead['sha256'];
	}): FileRead => ({
		bytes: Uint8Array.from(read.bytes),
		sha256: read.sha256,
	});

	async function children(directory: string) {
		const result = await call(commands.children(session, directory));
		if (!result.sent) return unsent(directory, 'list', result.cause);
		if (result.settled === 'refused') return Err(fileError(result.error));
		return Ok({
			files: sorted(result.data.files),
			directories: sorted(result.data.directories),
		});
	}

	async function read(path: string): Promise<Result<FileRead, FileError>> {
		const result = await call(commands.read(session, path));
		if (!result.sent) return unsent(path, 'read', result.cause);
		if (result.settled === 'refused') return Err(fileError(result.error));
		return Ok(toRead(result.data));
	}

	return {
		async list() {
			const result = await call(commands.list(session));
			if (!result.sent) return unsent('', 'enumerate', result.cause);
			if (result.settled === 'refused') return Err(fileError(result.error));
			const { files, directories } = result.data;
			return Ok({
				files: [...files].sort((a, b) =>
					a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
				),
				directories: sorted(directories),
			});
		},
		children,
		read,
		async readMany(paths) {
			const result = await call(commands.readMany(session, [...paths]));
			if (!result.sent) return unsent('', 'read', result.cause);
			if (result.settled === 'refused') return Err(fileError(result.error));
			const reads = new Map<string, Result<FileRead, FileError>>();
			result.data.forEach((entry, index) => {
				reads.set(
					paths[index] as string,
					entry.status === 'ok'
						? Ok(toRead(entry.value))
						: Err(fileError(entry.error)),
				);
			});
			return Ok(reads);
		},
		async open(path) {
			// The bytes are copied into memory, so replacing the path later does
			// not change what the consumer receives (ADR-0466).
			const { data: found, error: readError } = await read(path);
			if (readError !== null) return Err(readError);
			return Ok(new Blob([found.bytes as Uint8Array<ArrayBuffer>]));
		},
		async apply(changes) {
			const first = changes[0];
			const result = await call(
				commands.apply(session, changes.map(changeToWire)),
			);
			const outcome: Result<undefined, FileError | ApplyError> = !result.sent
				? // No reply: the batch may have been published. It is sent once.
					FileError.Unconfirmed({
						path:
							first === undefined
								? ''
								: first.kind === 'move'
									? first.from
									: first.path,
						operation: 'publishing to',
						cause: result.cause,
					})
				: result.settled === 'refused'
					? Err(applyError(result.error))
					: Ok(undefined);
			// The owner's change event is best effort, so this page announces
			// its own saves too. A listener that throws changes no outcome.
			hints.emit(mayHaveChanged(changes, outcome.error));
			return outcome;
		},
		async mkdir(path) {
			const result = await call(commands.mkdir(session, path));
			if (!result.sent)
				return FileError.Unconfirmed({
					path,
					operation: 'creating',
					cause: result.cause,
				});
			if (result.settled === 'refused') return Err(fileError(result.error));
			return Ok(undefined);
		},
		async rmdir(path) {
			const result = await call(commands.rmdir(session, path));
			if (!result.sent)
				return FileError.Unconfirmed({
					path,
					operation: 'removing',
					cause: result.cause,
				});
			if (result.settled === 'refused') return Err(fileError(result.error));
			return Ok(undefined);
		},
	};
}

/**
 * Stop this caller waiting when its signal aborts. The owner's work is shared
 * by every window, so a caller's signal never stops the work itself.
 */
function until<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	stopped: () => T,
): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.resolve(stopped());
	return new Promise<T>((resolve) => {
		const abort = () => resolve(stopped());
		signal.addEventListener('abort', abort, { once: true });
		void promise.then((value) => {
			signal.removeEventListener('abort', abort);
			resolve(value);
		});
	});
}

/**
 * History as the shell's owner reports it. The owner marks its own saves and
 * carries their coalesced automatic commit requests itself. The page exposes
 * history commands without repeating the owner's save accounting.
 */
function createHistory(
	session: number,
	snapshots: Snapshots,
	client: Client,
): FolderHistory {
	const closed = () => GitError.Closed();
	const closedCommit = (): CommitOutcome => ({ status: 'closed' });

	/** An explicit commit: the owner waits for the folder, then reads it. */
	async function commitNow(): Promise<CommitOutcome> {
		const result = await call(commands.commit(session));
		if (!result.sent)
			return { status: 'unconfirmed', error: describe(result.cause) };
		if (result.settled === 'refused')
			return result.error.name === 'Closed'
				? { status: 'closed' }
				: {
						status: 'failed',
						error: gitError(result.error, 'commit').message,
					};
		return commitOutcome(result.data);
	}

	/**
	 * Send one push or fetch on a request this session opens first. The owner
	 * knows the request before the command names it, so a caller that leaves
	 * can always withdraw it: the owner then starts no transport for it unless
	 * it already had. `'left'` means the caller left before the command was
	 * sent.
	 */
	async function requested<T>(
		leaving: AbortSignal,
		send: (request: number) => Promise<Wire<T, WireGitError>>,
	): Promise<Reply<T, WireGitError> | 'left'> {
		const opened = await call(commands.openRequest(session));
		if (!opened.sent || opened.settled === 'refused') return opened;
		const request = opened.data;
		const withdraw = () =>
			void commands.withdrawRequest(session, request).catch(() => {});
		if (leaving.aborted) {
			withdraw();
			return 'left';
		}
		leaving.addEventListener('abort', withdraw, { once: true });
		try {
			const reply = await call(send(request));
			// Without an acknowledged command, the owner may still hold the
			// request we opened. Release it; admitted transport is unaffected.
			if (!reply.sent && !leaving.aborted) withdraw();
			return reply;
		} finally {
			leaving.removeEventListener('abort', withdraw);
		}
	}

	async function pushNow(leaving: AbortSignal): Promise<PushOutcome> {
		const result = await requested(leaving, (request) =>
			commands.push(session, request),
		);
		if (result === 'left') return stoppedPush();
		if (!result.sent)
			return { status: 'unconfirmed', error: describe(result.cause) };
		// The owner refused before it pinned a commit: nothing was attempted,
		// so there is no commit to name.
		if (result.settled === 'refused')
			return result.error.name === 'Closed'
				? { status: 'closed' }
				: {
						status: 'skipped',
						reason: gitError(result.error, 'push').message,
					};
		return pushOutcome(result.data);
	}

	async function fetchNow(
		leaving: AbortSignal,
	): Promise<Result<FetchOutcome, GitError>> {
		const result = await requested(leaving, (request) =>
			commands.fetch(session, request),
		);
		if (result === 'left') return stoppedFetch();
		// A lost reply may have moved the remote-tracking ref.
		if (!result.sent)
			return GitError.Unconfirmed({ operation: 'fetch', cause: result.cause });
		if (result.settled === 'refused')
			return Err(gitError(result.error, 'fetch'));
		return Ok({ status: 'fetched', oid: orUndefined(result.data.oid) });
	}

	/** A command whose reply is a Git result, with nothing changed if it is lost. */
	function observe<T, U>(
		operation: string,
		request: () => Promise<Wire<T, WireGitError>>,
		value: (data: T) => U,
	): Promise<Result<U, GitError>> {
		return client.local(closed, async () => {
			const result = await call(request());
			if (!result.sent)
				return GitError.Failed({ operation, cause: result.cause });
			if (result.settled === 'refused')
				return Err(gitError(result.error, operation));
			return Ok(value(result.data));
		});
	}

	const stoppedPush = (): PushOutcome => ({ status: 'stoppedWaiting' });
	const closedPush = (): PushOutcome => ({ status: 'closed' });
	const stoppedFetch = () => GitError.StoppedWaiting({ operation: 'fetch' });

	return {
		get snapshot() {
			return snapshots.current;
		},
		subscribe: (listener) => snapshots.subscribe(listener),
		status: () =>
			observe(
				'status',
				() => commands.status(session),
				(files) => ({ head: orUndefined(files.head), changes: files.changes }),
			),
		commit: () => client.local(closedCommit, commitNow),
		async commitAndPush({ signal } = {}) {
			const commit = await until(
				client.local(closedCommit, commitNow),
				signal,
				(): CommitOutcome => ({ status: 'stoppedWaiting' }),
			);
			switch (commit.status) {
				case 'committed':
				case 'unchanged':
					break;
				// The commit's outcome is unknown, so whether there is anything
				// to push is unknown too: the push cannot be called skipped.
				case 'unconfirmed':
					return {
						commit,
						push: { status: 'unconfirmed', error: commit.error },
					};
				case 'stoppedWaiting':
					return { commit, push: { status: 'stoppedWaiting' } };
				case 'closed':
					return { commit, push: { status: 'closed' } };
				default:
					return {
						commit,
						push: { status: 'skipped', reason: 'the commit did not complete' },
					};
			}
			if (snapshots.current.remote === undefined)
				return { commit, push: { status: 'noRemote' } };
			// The push is this caller's next step, not the commit's. A caller
			// that stopped waiting asks for none; the commit it left still stands.
			const push = await client.network(
				closedPush,
				stoppedPush,
				signal,
				pushNow,
			);
			return { commit, push };
		},
		push: ({ signal } = {}) =>
			client.network(closedPush, stoppedPush, signal, pushNow),
		fetch: ({ signal } = {}) =>
			client.network(closed, stoppedFetch, signal, fetchNow),
		pullFastForward: () =>
			client.local(closed, async () => {
				const result = await call(commands.pullFastForward(session));
				if (!result.sent)
					return GitError.Unconfirmed({
						operation: 'pull',
						cause: result.cause,
					});
				if (result.settled === 'refused') return Err(pullError(result.error));
				return Ok(pullOutcome(result.data));
			}),
		// The desktop owner merges in Rust and has no sync rules for rows yet.
		sync: Object.freeze({
			supported: false,
			run: async () => SyncError.Unsupported({ runtime: 'desktop' }),
			resolve: async () => SyncError.Unsupported({ runtime: 'desktop' }),
		}),
		// Only because the page asked: the owner reports a pending update on
		// opening and in status, and never resumes it by itself.
		recoverIncoming: () =>
			client.local(
				closed,
				async (): Promise<Result<RecoverOutcome, PullError | GitError>> => {
					const result = await call(commands.recoverIncoming(session));
					if (!result.sent)
						return GitError.Unconfirmed({
							operation: 'recover',
							cause: result.cause,
						});
					if (result.settled === 'refused') return Err(pullError(result.error));
					return recoverOutcome(result.data);
				},
			),
		// Both options are sent explicitly, so the owner never reads a missing
		// one as anything but `false`.
		mergeIncoming: ({
			allowUnrelatedHistories = false,
			versions = false,
		} = {}) =>
			client.local(
				closed,
				async (): Promise<
					Result<MergeOutcome, MergeError | PullError | GitError>
				> => {
					const result = await call(
						commands.mergeIncoming(session, allowUnrelatedHistories, versions),
					);
					// A lost reply may have published the merge.
					if (!result.sent)
						return GitError.Unconfirmed({
							operation: 'merge',
							cause: result.cause,
						});
					if (result.settled === 'refused')
						return Err(mergeError(result.error));
					return Ok(mergeOutcome(result.data));
				},
			),
		paths: () =>
			observe(
				'status',
				() => commands.paths(session),
				(paths) =>
					paths.map((path) => ({
						path: path.path,
						index: path.index as StatusCode,
						worktree: path.worktree as StatusCode,
					})),
			),
		diff: (paths) =>
			observe(
				'diff',
				() => commands.diff(session, [...paths]),
				(text) => text,
			),
		log: (depth) =>
			observe(
				'log',
				() => commands.log(session, depth),
				(log) => log,
			),
		close: () => client.close(),
	};
}

/**
 * This page's Git calls: one lifetime for all of them, a terminal's
 * included. `fence` refuses new ones all at once and stops this page waiting
 * for network work. `close` also waits for local work that was already
 * running, so the session is not detached under it. Network work is the
 * owner's: closing stops this page waiting and withdraws its requests, so a
 * push or fetch the owner has not started never starts, and one it has
 * started runs to its end there.
 */
type Client = {
	/** Local work: refused once closing, otherwise waited for by `close`. */
	local<T>(closed: () => T, work: () => Promise<T>): Promise<T>;
	/**
	 * Network work: refused once closing, and not asked for on behalf of a
	 * caller whose signal has already aborted. `work` is given the signal that
	 * aborts when the caller leaves or the page closes, and withdraws its
	 * request then. Leaving stops the wait at once. It says nothing about the
	 * transport: the owner starts none for a request withdrawn in time, and
	 * finishes one it had already started.
	 */
	network<T>(
		closed: () => T,
		stopped: () => T,
		signal: AbortSignal | undefined,
		work: (leaving: AbortSignal) => Promise<T>,
	): Promise<T>;
	close(): Promise<void>;
};

function createClient(): Client {
	const controller = new AbortController();
	const running = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	return {
		local(closed, work) {
			if (controller.signal.aborted) return Promise.resolve(closed());
			const settling = work();
			running.add(settling);
			void settling.catch(() => {}).finally(() => running.delete(settling));
			return settling;
		},
		network(closed, stopped, signal, work) {
			if (controller.signal.aborted) return Promise.resolve(closed());
			if (signal?.aborted) return Promise.resolve(stopped());
			const leaving =
				signal === undefined
					? controller.signal
					: AbortSignal.any([controller.signal, signal]);
			return until(work(leaving), leaving, stopped);
		},
		close() {
			closing ??= (async () => {
				controller.abort();
				await Promise.allSettled([...running]);
			})();
			return closing;
		},
	};
}

/** The owner's latest snapshot, shared by every view of one attachment. */
type Snapshots = {
	readonly current: GitSnapshot;
	receive(snapshot: GitSnapshot): void;
	subscribe(listener: (snapshot: GitSnapshot) => void): () => void;
	clear(): void;
};

function createSnapshots(initial: GitSnapshot): Snapshots {
	let current = initial;
	const listeners = new Set<(snapshot: GitSnapshot) => void>();
	return {
		get current() {
			return current;
		},
		receive(next) {
			current = next;
			// One subscriber that throws does not keep the owner's snapshot from
			// the others.
			for (const listener of [...listeners])
				if (listeners.has(listener))
					callObserver('history subscriber', listener, current);
		},
		subscribe(listener) {
			listener(current);
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		clear: () => listeners.clear(),
	};
}

/**
 * Open the folder the shell registered under `id`. Refusals are returned, not
 * thrown: not running in the shell, a missing ID, a folder this window may
 * not use, a folder another process holds.
 */
export const openFolder: OpenFolder = async ({ definition, id }) => {
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(definition);
	if (definitionError !== null)
		return OpenFolderError.InvalidDefinition(definitionError);
	if (!isTauri()) return OpenFolderError.NotTauri();
	if (typeof id !== 'string' || id.trim() === '')
		return OpenFolderError.InvalidId({ id: String(id) });
	const scope = id;

	// Listen before attaching, so no event between the attach reply and the
	// first listener is lost. Events at or below the attach sequence are old.
	let history: Snapshots | undefined;
	let sequence = -1;
	const early: { sequence: number; snapshot: WireGitSnapshot }[] = [];
	// The owner announces every change it can, this window's included. Its
	// events are best effort; the boundary also announces this window's saves.
	const hints = createFileHints();
	const stopListening: (() => void)[] = [];
	const stop = () => {
		for (const unlisten of stopListening) unlisten();
	};
	try {
		stopListening.push(
			await events.folderSnapshotChanged.listen(({ payload }) => {
				if (payload.scope !== scope) return;
				if (history === undefined) {
					early.push(payload);
					return;
				}
				if (payload.sequence <= sequence) return;
				sequence = payload.sequence;
				history.receive(snapshotFromWire(payload.snapshot));
			}),
		);
		stopListening.push(
			await events.folderFilesChanged.listen(({ payload }) => {
				if (payload.scope !== scope) return;
				hints.receive(payload.paths);
			}),
		);
	} catch (cause) {
		stop();
		return OpenFolderError.Unavailable({ cause });
	}
	// The owner refuses a page built for another contract version here, before
	// the page can send it anything that changes the folder.
	const attached = await call(commands.attach(scope, FOLDER_PROTOCOL));
	if (!attached.sent) {
		stop();
		return OpenFolderError.Unavailable({ cause: attached.cause });
	}
	if (attached.settled === 'refused') {
		stop();
		const refusal = attached.error;
		switch (refusal.name) {
			case 'UnknownScope':
				return OpenFolderError.UnknownScope(refusal);
			case 'WindowNotPermitted':
				return OpenFolderError.WindowNotPermitted(refusal);
			case 'Busy':
				return OpenFolderError.Busy(refusal);
			case 'Unavailable':
				return OpenFolderError.Unavailable({ cause: refusal.message });
			case 'ShuttingDown':
				return OpenFolderError.ShuttingDown();
			case 'Incompatible':
				return OpenFolderError.Incompatible(refusal);
			default:
				return OpenFolderError.Unavailable({ cause: refusal });
		}
	}

	const { session, root } = attached.data;
	sequence = attached.data.sequence;
	const snapshots = createSnapshots(snapshotFromWire(attached.data.snapshot));
	history = snapshots;
	for (const event of early.sort((a, b) => a.sequence - b.sequence)) {
		if (event.sequence <= sequence) continue;
		sequence = event.sequence;
		snapshots.receive(snapshotFromWire(event.snapshot));
	}

	const client = createClient();

	const folder = assembleFolder<typeof definition>({
		prepared,
		storage: createBoundary(session, hints),
		// Closing the folder fences `client` through this history: Git calls
		// are refused, and running local ones are waited for, before
		// `release` detaches the session they use.
		history: createHistory(session, snapshots, client),
		location: { kind: 'directory', root },
		hints,
		// Detaches this window only. The owner keeps the folder, finishes the
		// work it already admitted for this page, and serves every other
		// window.
		release: async () => {
			stop();
			snapshots.clear();
			await commands.detach(session).catch(() => {});
		},
	});
	await publishDefinition(prepared, folder.files);
	return Ok(folder);
};
