/**
 * One request owns its checkpoint, transfers, publication and final inspection.
 * Native mutations run under the whole-operation history lock; file publication
 * separately takes the save lock, so local saves never wait on the network.
 * No operation schedules background work or requires a later close.
 */
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, LockingStorage } from '../boundary.js';
import { describe, UnconfirmedWrite } from '../errors.js';
import type {
	HistoryReply,
	HistoryRequest,
	HistoryResults,
} from '../history-wire.js';
import { ancestors, collisionKey, pathProblem } from '../paths.js';
import { sameContent } from '../shared/merge.js';
import { confirmedPut, publishFile } from '../write.js';
import { declaredFilter, isAttributesPath } from './attributes.js';
import type { GitBackend } from './backend.js';
import { GitError, SyncError } from './errors.js';
import { chooseBase, mergeHistories, mergeMessage } from './merge.js';
import { commitSubject, messageProblem, type PathChange } from './messages.js';
import {
	type Author,
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
import type { SyncOptions, SyncOutcome } from './sync.js';

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
	| { readonly status: 'unconfirmed'; readonly error: string };

/** What Sync's push of one commit did. */
export type PushOutcome =
	| { readonly status: 'pushed'; readonly oid: string }
	| { readonly status: 'failed'; readonly oid: string; readonly error: string }
	| { readonly status: 'cancelled'; readonly oid: string };

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

export type Attempt<T> = T & { readonly at: number };

type HistoryContext = {
	backend: GitBackend;
	boundary: LockingStorage;
	getAuthor: () => Author;
	/** Cancels transfers; local publication already started retains its outcome. */
	signal?: AbortSignal;
	log?: Logger;
};

/** Execute one request. The native entry owns the mutation's history lock. */
export async function executeHistoryRequest<TRequest extends HistoryRequest>(
	context: HistoryContext,
	request: TRequest,
): Promise<HistoryReply<HistoryResults[TRequest['op']]>>;
export async function executeHistoryRequest(
	{
		backend,
		boundary,
		getAuthor,
		signal = new AbortController().signal,
		log = createLogger('folder/history'),
	}: HistoryContext,
	request: HistoryRequest,
): Promise<HistoryReply<unknown>> {
	let lastCommit: Attempt<CommitOutcome> | undefined;
	let lastPush: Attempt<PushOutcome> | undefined;
	const landed = new Set<string>();
	// An observed event, not a comparison of the final working tree with HEAD.
	let changedSinceCheckpoint = false;
	let trackingUnconfirmed = false;

	// Diagnostics after an acknowledged effect must not revoke its receipt.
	function warn(operation: string, cause: unknown) {
		try {
			log.warn(GitError.Failed({ operation, cause }));
		} catch {
			/* The receipt still stands. */
		}
	}

	async function headFiles(head: string | undefined) {
		if (head === undefined)
			return new Map<string, { oid: string; mode: string }>();
		return backend.withObjects(async (access) =>
			readTreeFiles(access, await commitTree(access, head)),
		);
	}

	async function inspectSync(): Promise<SyncObservation | undefined> {
		if (trackingUnconfirmed) return undefined;
		try {
			await backend.refreshRemote();
			const head = await backend.readBranch();
			const remote = await backend.readRemoteTracking();
			const [ahead, behind] = await backend.withObjects(async (access) => {
				const ahead = await countOnly(access, head, remote);
				const behind = await countOnly(access, remote, head);
				return [ahead, behind];
			});
			return { head, remote, ahead, behind };
		} catch (cause) {
			warn('inspect sync', cause);
			return undefined;
		}
	}

	/** A disappearing file is absent; other read failures cannot imply clean. */
	async function readFiles(
		paths: readonly string[],
		files = new Map<string, Uint8Array>(),
	) {
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

	/** Capture rule bytes once, both for selection and for the recorded tree. */
	async function captureRules() {
		const { data: listed, error } = await boundary.list();
		if (error !== null) throw new Error(error.message);
		const paths = listed.files
			.map(({ path }) => path)
			.filter((path) => pathProblem(path) === undefined);
		const rulePath = (path: string) =>
			path === '.gitignore' || path.endsWith('/.gitignore');
		const rules = await readFiles(paths.filter(rulePath));
		return { paths, rules, payloads: paths.filter((path) => !rulePath(path)) };
	}

	/** Read all source bytes afresh, excluding only untracked ignored payloads. */
	async function capture(tracked: ReadonlyMap<string, unknown>) {
		const { paths, rules, payloads } = await captureRules();
		const candidates = paths.filter((path) => !tracked.has(path));
		const ignored =
			candidates.length === 0
				? new Set<string>()
				: await backend.ignoredPaths(candidates, rules);
		const files = new Map([...rules].filter(([path]) => !ignored.has(path)));
		return readFiles(
			payloads.filter((path) => !ignored.has(path)),
			files,
		);
	}

	async function inspectFiles(): Promise<Result<FilesObservation, GitError>> {
		try {
			// Pin the tree whose tracked paths must bypass ignore rules.
			const head = await backend.readBranch();
			const committed = await headFiles(head);
			const hashes = await hashFiles(await capture(committed));
			return Ok({ head, changes: diffFileMaps(committed, hashes) });
		} catch (cause) {
			return GitError.Failed({ operation: 'status', cause });
		}
	}

	/**
	 * One whole-folder commit, under the whole-operation history lock. A
	 * branch that moved under the first attempt is met by one more, from a
	 * fresh capture over the new head (ADR-0541): the files are still on
	 * disk, so it records everything the lost attempt held. A second move is
	 * reported.
	 */
	async function commitCurrentFiles(subject?: string): Promise<CommitOutcome> {
		const first = await attemptCommit(subject);
		return first.status === 'branchMoved' ? attemptCommit(subject) : first;
	}

	/**
	 * One attempt at a whole-folder commit, under the request's history lock.
	 * `subject` is the message a person gave; without it the message names
	 * what changed.
	 */
	async function attemptCommit(subject?: string): Promise<CommitOutcome> {
		// A folder whose repository its first commit creates gets it here.
		const unborn = await backend.createRepository?.();
		if (unborn !== undefined) return { status: 'blocked', reason: unborn };
		const blocked = await backend.blocked();
		if (blocked !== undefined) return { status: 'blocked', reason: blocked };
		const unfinished = await finishPublishing();
		if (unfinished !== undefined)
			return { status: 'blocked', reason: unfinished };
		// Pin the parent before capture, after acquiring the request's history lock.
		// Native Git outside that lock can still move it; CAS detects that race.
		const parent = await backend.readBranch();
		const committed = await headFiles(parent);
		const included = await capture(committed);
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
							author: getAuthor(),
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

	async function commitNow(subject?: string): Promise<CommitOutcome> {
		if (subject !== undefined) {
			const problem = messageProblem(subject);
			if (problem !== undefined) return { status: 'failed', error: problem };
		}
		let outcome: CommitOutcome;
		try {
			outcome = await commitCurrentFiles(subject);
		} catch (cause) {
			outcome =
				cause instanceof UnconfirmedWrite
					? { status: 'unconfirmed', error: describe(cause) }
					: { status: 'failed', error: describe(cause) };
		}
		lastCommit = { ...outcome, at: Date.now() };
		if (outcome.status === 'committed' || outcome.status === 'unchanged')
			changedSinceCheckpoint = false;
		return outcome;
	}

	async function fetchRemote(): Promise<Result<string | undefined, GitError>> {
		try {
			if ((await backend.refreshRemote()) === undefined)
				return GitError.NoRemote();
			const head = await backend.fetch(signal);
			// A pushed merge can discover another edit and fetch again.
			trackingUnconfirmed = false;
			return Ok(head);
		} catch (cause) {
			return GitError.Failed({ operation: 'fetch', cause });
		}
	}

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
		const attributeFiles = await backend.withObjects(async (access) => {
			const attributes: [string, Uint8Array][] = [];
			for (const [path, entry] of files)
				if (isAttributesPath(path))
					attributes.push([path, await readBlob(access, entry.oid)]);
			return attributes;
		});
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
	 * them.
	 */
	async function between(from: string | undefined, to: string) {
		const before = await headFiles(from);
		const after = await headFiles(to);
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
		const { rules } = await captureRules();
		const ignored = await backend.ignoredPaths(untracked, rules);
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
				author: getAuthor(),
			}),
		);
		await backend.writePublishing(marker);
	}

	/**
	 * Under the request's history lock, before any commit records the files: finish a
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
	 * Under the request's history lock: write the tree of `to` over the files, which the
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
		const plan = await between(from, to);
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
					// holds yet: recorded first, the merge keeps the incoming
					// edit at its path and names the removal it gave way to.
					if (!resuming)
						for (const path of writes) {
							if (blobs.get(path)!.was === null) continue;
							if ((await held.read(path)).error?.name === 'NotFound')
								return Ok('edited');
						}
					for (const { path, sha256 } of targets) {
						const put = await confirmedPut(held, path, null, { sha256 }, null);
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
				const outcome = await boundary.lock(async (held) => {
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
					return publishFile(held, path, was, next);
				});
				const { data: wrote, error } = outcome;
				// A file this folder cannot take there, from a program outside
				// the save lock or a name the disk holds under another spelling.
				if (error !== null) return failed(path, error);
				if (!sameContent(wrote.file?.bytes ?? null, next)) kept = true;
				reached.push(path);
			}
			const moved = await backend.casBranch(from, to);
			// Either way the files now belong to the branch as it is.
			if (!moved.ok) {
				await unmark();
				return SyncError.Blocked({
					reason: `the branch moved to ${moved.actual ?? 'no commit'} while Sync wrote its files, which are now changes to it`,
				});
			}
			await unmark().catch((cause) => warn('clear publishing marker', cause));
			// The branch holds the files now. An index another program holds
			// is left as it is, as a commit leaves it: the next commit
			// refreshes it.
			await backend
				.reconcileIndex(to)
				.catch((cause) => warn('reconcile published index', cause));
			return Ok({ kind: 'published' } as const);
		} finally {
			// Heard once the branch and the index are set, or the publish
			// stopped: a status taken between them would be of neither.
			changedSinceCheckpoint ||= kept;
			for (const path of reached) landed.add(path);
		}
	}

	/** Push one exact commit. Tracking repair is secondary to remote acceptance. */
	async function pushCommit(oid: string): Promise<PushOutcome | 'rejected'> {
		let outcome: PushOutcome;
		try {
			const pushed = await backend.push(oid, signal);
			if (pushed === 'rejected') return pushed;
			trackingUnconfirmed = pushed.trackingWarning !== undefined;
			if (trackingUnconfirmed)
				warn('update remote tracking after push', pushed.trackingWarning);
			outcome = { status: 'pushed', oid };
		} catch (cause) {
			outcome = signal.aborted
				? { status: 'cancelled', oid }
				: { status: 'failed', oid, error: describe(cause) };
		}
		lastPush = { ...outcome, at: Date.now() };
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
	async function runSync({
		allowUnrelatedHistories = false,
	}: SyncOptions = {}): Promise<Result<SyncOutcome, SyncError>> {
		try {
			const remote = await backend.refreshRemote();
			if (remote === undefined) return SyncError.NoRemote();
			const checkpoint = await commitNow();
			switch (checkpoint.status) {
				case 'committed':
				case 'unchanged':
					break;
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
				const changedSince = changedSinceCheckpoint;
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
				const again = await commitNow();
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
				const { data: theirs, error: fetchError } = await fetchRemote();
				if (fetchError !== null) return SyncError.Fetch({ error: fetchError });
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
					// This folder is behind: take theirs, preserving newer local edits.
					const { data: published, error } = await publishWithin(
						local,
						theirs,
						{ resuming: false },
					);
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
						author: getAuthor(),
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
				const { made, ignored } = await madeHere(way.untracked);
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
				const { data: published, error } = await publishWithin(mine, merged, {
					resuming: false,
				});
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
		} catch (cause) {
			return SyncError.Failed({ cause });
		}
	}

	let result: unknown;
	let files: FilesObservation | undefined;
	switch (request.op) {
		case 'status': {
			const observed = await inspectFiles();
			result = observed;
			if (observed.error === null) files = observed.data;
			break;
		}
		case 'log':
			try {
				result = Ok(await backend.log(request.depth));
			} catch (cause) {
				result = GitError.Failed({ operation: 'log', cause });
			}
			break;
		case 'saveVersion':
			result = await commitNow(request.message);
			break;
		case 'sync':
			// Connecting is setup: preserve its existing throwing failure contract.
			if (request.connect !== undefined)
				await backend.setRemote(request.connect);
			result = await runSync(request);
			break;
	}
	if (request.op === 'saveVersion' || request.op === 'sync') {
		const observed = await inspectFiles();
		if (observed.error === null) files = observed.data;
		else warn('inspect files', observed.error);
	}
	const sync = request.op === 'log' ? undefined : await inspectSync();
	return {
		result,
		state: {
			branch: backend.branch,
			remote: backend.remote,
			files,
			sync,
			lastCommit,
			lastPush,
		},
		landed: [...landed].sort(),
	};
}
