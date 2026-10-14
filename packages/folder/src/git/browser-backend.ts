/**
 * Browser Git: isomorphic-git over a folder's private Git state.
 *
 * `createStoredGitBackend` is everything that is Git: status, staging,
 * commits, diffs, and transfers, through a filesystem view whose `/files` is
 * the folder's files, read-only, and whose `/git` is private Git state. A
 * `BrowserGitStore` decides where that private state lives and how the
 * branch, the index, and an incoming update publish; the browser folder's is
 * `.git` of its origin private file system directory (`opfs-git.ts`).
 *
 * The branch moves only by comparing the stored ref with the pinned value.
 * Index and branch work holds a Web Lock, which queues this tab's requests
 * with every other tab's of the same origin, so none interleave index writes.
 * Network transfers run outside the lock.
 */

import type { PromiseFsClient } from 'isomorphic-git';
import * as git from 'isomorphic-git';
import type { OpfsLocks } from '../opfs-store.js';
import { isAttributesPath, normalizingAttribute } from './attributes.js';
import type {
	CasResult,
	GitBackend,
	GitRemote,
	IncomingPlan,
	PathStatus,
	PendingIncoming,
	PublishResult,
	RecoverIncomingResult,
	StatusCode,
} from './backend.js';
import { capturedIndexMatchesHead } from './captured-index.js';
import { abortableHttp, type HttpFetch } from './http.js';
import { orphanStagesProblem, parseIndex } from './index-file.js';
import {
	commitTree,
	EMPTY_TREE,
	logCommits,
	type ObjectAccess,
	readBlob,
} from './objects.js';
import { gitignoreMatcher } from './scope.js';
import { webLockExclusive } from './web-lock-exclusive.js';

const decoder = new TextDecoder();
const REMOTE_NAME = 'origin';

/** One piece of Git work's filesystem view; `flush` persists its private writes. */
export type GitFsSession = {
	readonly fs: PromiseFsClient;
	flush(): Promise<void>;
};

/** Where a browser folder's private Git state lives, and how it publishes. */
export type BrowserGitStore<TSession extends GitFsSession> = {
	session(): TSession;
	/** A private Git file's bytes by its `/git/...` path, or `undefined`. */
	readPrivate(path: string): Promise<Uint8Array | undefined>;
	/** Move a ref only if it still names `expected`. */
	casRef(
		path: string,
		expected: string | undefined,
		next: string,
	): Promise<CasResult>;
	/**
	 * Publish files, index, and branch for an incoming update. `prepared` holds
	 * the index entries already reset to `plan.nextHead`, unflushed.
	 */
	publishIncoming(
		plan: IncomingPlan,
		prepared: TSession,
	): Promise<PublishResult>;
	/**
	 * The incoming update whose publication began and has not been recovered.
	 * While there is one, staging, commits, and new incoming updates wait.
	 * Throws when a record exists but cannot be read.
	 */
	pending(): Promise<PendingIncoming | undefined>;
	/** Finish or clear the pending update. Called inside the Git lock, only when asked. */
	recover(): Promise<RecoverIncomingResult>;
};

/** isomorphic-git's view of private Git state. */
/**
 * A backend over a private repository it creates when first needed. A
 * browser folder creates it with its directory, by `ensureRepository`; any
 * Git write creates it too. Until then reads find no history.
 */
export type StoredGitBackend = GitBackend & {
	ensureRepository(): Promise<void>;
};

export const GITDIR = '/git';
/** isomorphic-git's read-only view of the folder's files. */
export const WORKDIR = '/files';

export const sameBytes = (
	left: Uint8Array | undefined,
	right: Uint8Array | undefined,
) =>
	left === undefined || right === undefined
		? left === right
		: left.byteLength === right.byteLength &&
			left.every((byte, index) => byte === right[index]);

/** The commit a stored ref names, or `undefined` for anything else. */
export function refValue(value: Uint8Array | undefined): string | undefined {
	if (value === undefined) return undefined;
	const text = decoder.decode(value).trim();
	return /^[0-9a-f]{40}$/.test(text) ? text : undefined;
}

/**
 * Set the index entries of `paths` to `commit`'s tree, in `fs` (unflushed):
 * entries of `removed` paths go, the others take the commit's blob.
 * `resetIndex` alone would keep a removed file's entry where the commit has
 * a directory of the same name.
 */
export async function indexTo(
	fs: PromiseFsClient,
	commit: string,
	paths: readonly string[],
	removed: ReadonlySet<string>,
) {
	for (const filepath of paths)
		if (removed.has(filepath))
			await git.remove({
				fs,
				dir: WORKDIR,
				gitdir: GITDIR,
				filepath,
				cache: {},
			});
	for (const filepath of paths)
		if (!removed.has(filepath))
			await git.resetIndex({
				fs,
				dir: WORKDIR,
				gitdir: GITDIR,
				filepath,
				ref: commit,
				cache: {},
			});
}

/** Why index and branch work waits for `pending`. */
export function pendingReason(pending: PendingIncoming): string {
	switch (pending.state) {
		case 'recorded':
			return `Incoming update ${pending.operationId} from ${pending.expectedHead ?? 'an empty history'} to ${pending.nextHead} has not finished; recover it with recoverIncoming()`;
		case 'unadmitted':
			return 'An incoming update was never admitted: its record is empty; recoverIncoming() clears it';
		case 'unreadable':
			return `The incoming update record cannot be read (${pending.reason}); it needs review before Git work continues`;
	}
}

export async function createStoredGitBackend<TSession extends GitFsSession>({
	store,
	locks,
	lockName,
	createLock,
	branch,
	httpFetch,
}: {
	store: BrowserGitStore<TSession>;
	/** The Web Locks this folder's tabs share. */
	locks: OpfsLocks;
	lockName: string;
	/**
	 * The lock every opener of this folder holds while it creates the
	 * repository, so two that open a new folder at once never both create it.
	 * Omitted, creation is not coordinated.
	 */
	createLock?: string;
	branch: string;
	httpFetch?: HttpFetch;
}): Promise<StoredGitBackend> {
	const branchKey = `${GITDIR}/refs/heads/${branch}`;
	const indexKey = `${GITDIR}/index`;
	const mergeHeadKey = `${GITDIR}/MERGE_HEAD`;
	const trackingKey = `${GITDIR}/refs/remotes/${REMOTE_NAME}/${branch}`;

	async function withObjects<T>(
		work: (access: ObjectAccess) => Promise<T>,
	): Promise<T> {
		const session = store.session();
		const value = await work({ fs: session.fs, gitdir: GITDIR, cache: {} });
		await session.flush();
		return value;
	}

	const readRef = async (key: string) => refValue(await store.readPrivate(key));

	/** Refuse index and branch work while an incoming update is pending. */
	async function settled() {
		const pending = await store.pending();
		if (pending !== undefined) throw new Error(pendingReason(pending));
	}

	// Create the private repository when it is first needed. Only creation
	// writes `HEAD`, so a missing or empty `HEAD` means creation did not
	// finish: `init` stops at a `config` it already wrote, so `HEAD` is
	// written here. Two handles can create it at once, so creation runs under
	// `createLock` and asks again there, only when there is no `HEAD`.
	const created = async () => {
		const head = await store.readPrivate(`${GITDIR}/HEAD`);
		return head !== undefined && head.byteLength > 0;
	};
	const create = async () => {
		if (await created()) return;
		await withObjects(async ({ fs, gitdir }) => {
			await git.init({ fs, dir: WORKDIR, gitdir, defaultBranch: branch });
			const written = await fs.promises
				.readFile(`${gitdir}/HEAD`)
				.then((bytes: Uint8Array) => bytes.byteLength > 0)
				.catch(() => false);
			if (!written)
				await fs.promises.writeFile(
					`${gitdir}/HEAD`,
					`ref: refs/heads/${branch}\n`,
				);
			await git.setConfig({
				fs,
				gitdir,
				path: 'core.autocrlf',
				value: 'false',
			});
		});
	};
	/** The creation this handle is running, whose own writes make the directory. */
	let creating: Promise<void> | undefined;
	/** Create the repository if there is none: a write needs one. */
	async function ensureCreated() {
		if (await created()) return;
		creating ??= (
			createLock === undefined
				? create()
				: locks.request(createLock, {}, create)
		).finally(() => {
			creating = undefined;
		});
		await creating;
	}
	/**
	 * Create the repository with the folder's directory. The directory may be
	 * made by this handle's own creation, which already holds the lock; that
	 * creation finishes the repository.
	 */
	async function ensureRepository() {
		if (creating !== undefined) return;
		await ensureCreated();
	}
	/** Whether there is a repository to read. A read never creates one. */
	const available = created;
	/**
	 * Whether a write has a repository to write to, creating it for files a
	 * directory holds without one (a creation that stopped partway). A folder
	 * with no files stays as it is.
	 */
	async function writable() {
		if (await created()) return true;
		const files = await withObjects(({ fs }) =>
			fs.promises.readdir(WORKDIR).then(
				(entries: string[]) => entries.length > 0,
				() => false,
			),
		);
		if (files) await ensureCreated();
		return files;
	}

	/** The remote Git configuration names, read without writing. */
	async function configuredRemote(): Promise<GitRemote | undefined> {
		if (!(await created())) return undefined;
		const url: unknown = await withObjects(({ fs, gitdir }) =>
			git.getConfig({ fs, gitdir, path: `remote.${REMOTE_NAME}.url` }),
		);
		return typeof url === 'string' && url !== '' ? { url, branch } : undefined;
	}
	let remote = await configuredRemote();

	const exclusive = webLockExclusive(locks, lockName);

	async function casBranch(
		expected: string | undefined,
		next: string,
	): Promise<CasResult> {
		await settled();
		await ensureCreated();
		return store.casRef(branchKey, expected, next);
	}

	function matrixCodes(
		head: number,
		workdir: number,
		stage: number,
	): PathStatus['index'][] {
		let index: StatusCode = ' ';
		if (head === 0 && stage !== 0) index = 'A';
		else if (head === 1 && stage === 0) index = 'D';
		else if (head === 1 && (stage === 2 || stage === 3)) index = 'M';
		let worktree: StatusCode = ' ';
		if (stage === 0) worktree = workdir === 0 ? ' ' : '?';
		// Untracked, as `git status --porcelain` reports it: `??`.
		if (head === 0 && stage === 0 && workdir !== 0) index = '?';
		else if (stage === 1)
			worktree = workdir === 0 ? 'D' : workdir === 2 ? 'M' : ' ';
		else if (stage === 3) worktree = workdir === 0 ? 'D' : 'M';
		return [index, worktree];
	}

	/**
	 * isomorphic-git's status walk, with its index refresh off. That refresh
	 * writes a merged entry for a file whose bytes equal the stage it looked
	 * at, which would resolve an unmerged path by reading it. Stats here are
	 * never cached anyway (see `opfs-git.ts`), so it saves nothing.
	 */
	async function matrix(access: ObjectAccess, filepaths?: string[]) {
		const hasHead = (await readRef(branchKey)) !== undefined;
		if (!hasHead) {
			// isomorphic-git's statusMatrix needs a resolvable HEAD; compare the
			// index and working files against an empty history instead.
			const rows: [string, number, number, number][] = [];
			await git.walk({
				...access,
				dir: WORKDIR,
				trees: [git.STAGE(), git.WORKDIR({ refresh: false })],
				map: async (filepath, [stage, workdir]) => {
					if (filepath === '.') return undefined;
					if (
						filepaths &&
						!filepaths.some(
							(p) =>
								filepath === p || filepath.startsWith(`${p}/`) || p === '.',
						)
					) {
						const isAncestor = filepaths.some((p) =>
							p.startsWith(`${filepath}/`),
						);
						return isAncestor ? undefined : null;
					}
					const stageType = stage ? await stage.type() : undefined;
					const workType = workdir ? await workdir.type() : undefined;
					if (stageType === 'tree' || workType === 'tree') return undefined;
					if (stageType === undefined && workType === undefined)
						return undefined;
					const stageOid = stage ? await stage.oid() : undefined;
					const workOid = workdir ? await workdir.oid() : undefined;
					const s =
						stageOid === undefined
							? 0
							: workOid === undefined
								? 3
								: stageOid === workOid
									? 2
									: 3;
					const w = workOid === undefined ? 0 : 2;
					rows.push([filepath, 0, w, s]);
					return undefined;
				},
			});
			return rows;
		}
		return git.statusMatrix({
			...access,
			dir: WORKDIR,
			ref: branchKey.slice(GITDIR.length + 1),
			filepaths,
			refresh: false,
		});
	}

	/** Each unmerged path's stages, from the stored index. */
	async function unmergedStages(): Promise<Map<string, Set<number>>> {
		const bytes = await store.readPrivate(indexKey);
		const stages = new Map<string, Set<number>>();
		if (bytes === undefined) return stages;
		for (const entry of parseIndex(bytes) ?? [])
			if (entry.stage !== 0)
				stages.set(
					entry.path,
					(stages.get(entry.path) ?? new Set()).add(entry.stage),
				);
		return stages;
	}

	async function blobText(
		access: ObjectAccess,
		oid: string | undefined,
	): Promise<{ text: string; binary: boolean }> {
		if (oid === undefined) return { text: '', binary: false };
		const { blob } = await git.readBlob({ ...access, oid });
		return { text: decoder.decode(blob), binary: blob.includes(0) };
	}

	const backend: StoredGitBackend = {
		ensureRepository,
		branch,
		get remote() {
			return remote;
		},
		async refreshRemote() {
			remote = await configuredRemote();
			return remote;
		},
		async setRemote(url) {
			await ensureCreated();
			// The fetch refspec makes isomorphic-git record fetched and pushed
			// heads as tracking refs.
			await withObjects(async ({ fs, gitdir }) => {
				await git.setConfig({
					fs,
					gitdir,
					path: `remote.${REMOTE_NAME}.url`,
					value: url,
				});
				await git.setConfig({
					fs,
					gitdir,
					path: `remote.${REMOTE_NAME}.fetch`,
					value: `+refs/heads/*:refs/remotes/${REMOTE_NAME}/*`,
				});
			});
			remote = { url, branch };
			return remote;
		},
		withObjects,
		exclusive,
		readBranch: () => readRef(branchKey),
		readRemoteTracking: () => readRef(trackingKey),
		casBranch,
		replacesDirectories: true,
		pendingIncoming: () => store.pending(),
		recoverIncoming: () => store.recover(),
		async blocked() {
			try {
				const pending = await store.pending();
				if (pending !== undefined) return pendingReason(pending);
			} catch (cause) {
				return `The incoming update record cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`;
			}
			// A folder with no repository yet has nothing in progress.
			if (!(await available())) return undefined;
			const head = await store.readPrivate(`${GITDIR}/HEAD`);
			if (head === undefined || !decoder.decode(head).startsWith('ref: '))
				return 'HEAD is detached';
			if (decoder.decode(head).trim() !== `ref: refs/heads/${branch}`)
				return `HEAD is not on ${branch}`;
			if ((await store.readPrivate(mergeHeadKey)) !== undefined)
				return 'a Git merge is in progress (.git/MERGE_HEAD); this folder no longer finishes merges left in place. Remove .git/MERGE_HEAD and reset the index to continue, then Sync';
			return undefined;
		},
		async checkpointProblem() {
			// Browser files are plain bytes with no modes, links, or filters.
			// Stages are what is left of a merge an earlier version left in place.
			return orphanStagesProblem([...(await unmergedStages()).keys()]);
		},
		async incomingAttribute(_commit, files) {
			// There is no Git program here. The tree's own attribute files are
			// read and evaluated as Git would evaluate them.
			const attributeFiles = new Map<string, Uint8Array>();
			await withObjects(async (access) => {
				for (const [path, file] of files)
					if (isAttributesPath(path))
						attributeFiles.set(path, await readBlob(access, file.oid));
			});
			return normalizingAttribute(attributeFiles, files.keys());
		},
		async reconcileIndex(commit) {
			await settled();
			await ensureCreated();
			return withObjects(async (access) => {
				const mismatched: string[] = [];
				await git.walk({
					...access,
					dir: WORKDIR,
					trees: [git.TREE({ ref: commit }), git.STAGE()],
					map: async (filepath, [tree, stage]) => {
						if (filepath === '.') return undefined;
						const [treeType, stageType] = await Promise.all([
							tree?.type(),
							stage?.type(),
						]);
						const treeOid = treeType === 'blob' ? await tree?.oid() : undefined;
						const stageOid =
							stageType === 'blob' ? await stage?.oid() : undefined;
						if (treeOid !== stageOid) mismatched.push(filepath);
						return undefined;
					},
				});
				for (const filepath of mismatched)
					await git.resetIndex({
						...access,
						dir: WORKDIR,
						filepath,
						ref: commit,
					});
			});
		},
		async ignoredPaths(candidates, current) {
			const ignored = gitignoreMatcher(current);
			return new Set(candidates.filter((path) => ignored(path)));
		},
		async indexMatchesHead(captured) {
			return withObjects((access) =>
				capturedIndexMatchesHead(access, captured),
			);
		},
		readIndex: () => store.readPrivate(indexKey),
		async pathStatus() {
			if (!(await available())) return [];
			const rows = await withObjects((access) => matrix(access));
			const result: PathStatus[] = [];
			for (const [path, head, workdir, stage] of rows) {
				const [index, worktree] = matrixCodes(head, workdir, stage) as [
					StatusCode,
					StatusCode,
				];
				if (index === ' ' && worktree === ' ') continue;
				result.push({ path, index, worktree });
			}
			return result;
		},
		async stage(paths) {
			await settled();
			// A folder with no files has nothing to stage.
			if (!(await writable())) return;
			await withObjects(async (access) => {
				const rows = await matrix(
					access,
					paths === 'all' ? undefined : [...paths],
				);
				if (paths !== 'all') {
					for (const path of paths) {
						if (path === '.') continue;
						const matched = rows.some(
							([filepath]) =>
								filepath === path || filepath.startsWith(`${path}/`),
						);
						if (!matched)
							throw new Error(`pathspec '${path}' did not match any files`);
					}
				}
				for (const [filepath, , workdir, stage] of rows) {
					if (workdir === 0) {
						if (stage !== 0)
							await git.remove({ ...access, dir: WORKDIR, filepath });
					} else if (stage !== 2 || workdir !== 2) {
						await git.add({ ...access, dir: WORKDIR, filepath });
					}
				}
			});
		},
		async commitIndex(message, author) {
			await settled();
			if (!(await writable())) return { status: 'nothing' };
			const session = store.session();
			const access: ObjectAccess = {
				fs: session.fs,
				gitdir: GITDIR,
				cache: {},
			};
			const parent = await readRef(branchKey);
			const now = new Date();
			const signature = {
				name: author.name,
				email: author.email,
				timestamp: Math.floor(now.getTime() / 1000),
				timezoneOffset: now.getTimezoneOffset(),
			};
			const oid = await git.commit({
				...access,
				dir: WORKDIR,
				message: message.endsWith('\n') ? message : `${message}\n`,
				author: signature,
				committer: signature,
				noUpdateBranch: true,
				parent: parent === undefined ? [] : [parent],
			});
			const tree = await commitTree(access, oid);
			const parentTree =
				parent === undefined ? EMPTY_TREE : await commitTree(access, parent);
			if (tree === parentTree) return { status: 'nothing' };
			await session.flush();
			const moved = await store.casRef(branchKey, parent, oid);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					expected: parent,
					actual: moved.actual,
				};
			return { status: 'committed', oid, parent };
		},
		async diff({ staged, paths }) {
			// Loaded when a diff is first asked for. The shell uses the same
			// library, and a bundler keeps one copy: imported statically here, that
			// copy would sit in this adapter's chunk, and a desktop page running a
			// shell command would load the browser's Git with it.
			const { createTwoFilesPatch } = await import('diff');
			if (!(await available())) return '';
			return withObjects(async (access) => {
				const head = await readRef(branchKey);
				const filepaths = paths.length === 0 ? undefined : [...paths];
				const outputs: string[] = [];
				// No index refresh, as in `matrix`: a diff never writes the index.
				const workdir = git.WORKDIR({ refresh: false });
				const trees =
					head === undefined
						? [git.STAGE(), workdir]
						: [git.TREE({ ref: head }), git.STAGE(), workdir];
				await git.walk({
					...access,
					dir: WORKDIR,
					trees,
					map: async (filepath, entries) => {
						if (filepath === '.') return undefined;
						if (
							filepaths &&
							!filepaths.some(
								(p) =>
									filepath === p ||
									filepath.startsWith(`${p}/`) ||
									p.startsWith(`${filepath}/`) ||
									p === '.',
							)
						)
							return null;
						const [headEntry, stageEntry, workEntry] =
							head === undefined ? [null, entries[0], entries[1]] : entries;
						const types = await Promise.all(
							[headEntry, stageEntry, workEntry].map((entry) => entry?.type()),
						);
						if (types.includes('tree')) return undefined;
						const oids = await Promise.all(
							[headEntry, stageEntry, workEntry].map((entry) => entry?.oid()),
						);
						const [headOid, stageOid, workOid] = oids;
						// Unstaged diff compares the index with files; untracked files are not shown.
						const [before, after] = staged
							? [headOid, stageOid]
							: [stageOid, workOid];
						if (!staged && stageOid === undefined) return undefined;
						if (before === after) return undefined;
						const [left, right] = await Promise.all([
							blobText(access, before),
							!staged && workEntry
								? (async () => {
										const content = await workEntry.content();
										const bytes = content ?? new Uint8Array();
										return {
											text: decoder.decode(bytes),
											binary: bytes.includes(0),
										};
									})()
								: blobText(access, after),
						]);
						const header = `diff --git a/${filepath} b/${filepath}\n`;
						if (left.binary || right.binary) {
							outputs.push(`${header}Binary files differ\n`);
							return undefined;
						}
						const patch = createTwoFilesPatch(
							before === undefined ? '/dev/null' : `a/${filepath}`,
							after === undefined && !(!staged && workEntry)
								? '/dev/null'
								: `b/${filepath}`,
							left.text,
							right.text,
							undefined,
							undefined,
							{ context: 3 },
						);
						outputs.push(header + patch.replace(/^=+\n/, ''));
						return undefined;
					},
				});
				return outputs.join('');
			});
		},
		async log(depth) {
			const head = await readRef(branchKey);
			if (head === undefined) return [];
			return withObjects((access) => logCommits(access, head, depth));
		},
		async push(oid, signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const { url, branch: remoteBranch } = remote;
			await withObjects(async (access) => {
				let result: Awaited<ReturnType<typeof git.push>>;
				try {
					result = await git.push({
						...access,
						http: abortableHttp(signal, httpFetch),
						dir: WORKDIR,
						url: url,
						remote: REMOTE_NAME,
						ref: oid,
						remoteRef: `refs/heads/${remoteBranch}`,
						force: false,
					});
				} catch (cause) {
					// isomorphic-git refuses this itself, before it sends the update, and
					// its own message advises forcing, which a folder never does.
					if (
						cause instanceof git.Errors.PushRejectedError &&
						cause.data.reason === 'not-fast-forward'
					)
						throw new Error(
							`The remote branch '${remoteBranch}' cannot be updated by a fast-forward`,
							{ cause },
						);
					throw cause;
				}
				const status = result.refs[`refs/heads/${remoteBranch}`];
				if (!result.ok || (status && !status.ok))
					throw new Error(
						status?.error ?? result.error ?? 'The remote rejected the push',
					);
			});
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const { url, branch: remoteBranch } = remote;
			await ensureCreated();
			return withObjects(async (access) => {
				try {
					const result = await git.fetch({
						...access,
						http: abortableHttp(signal, httpFetch),
						dir: WORKDIR,
						url: url,
						remote: REMOTE_NAME,
						ref: remoteBranch,
						remoteRef: remoteBranch,
						singleBranch: true,
						tags: false,
					});
					return result.fetchHead ?? undefined;
				} catch (cause) {
					if (
						cause instanceof Error &&
						(cause as { code?: string }).code === 'NotFoundError' &&
						cause.message.includes(remoteBranch)
					)
						return undefined;
					throw cause;
				}
			});
		},
		async publishIncoming(plan: IncomingPlan) {
			await settled();
			await ensureCreated();
			// Compute index entries for the new head without writing them; the
			// store publishes them with the files and the branch.
			const session = store.session();
			await indexTo(
				session.fs,
				plan.nextHead,
				plan.changes.flatMap((change) =>
					change.kind === 'move' ? [] : [change.path],
				),
				new Set(
					plan.changes
						.filter((change) => change.kind === 'remove')
						.map((change) => (change as { path: string }).path),
				),
			);
			return store.publishIncoming(plan, session);
		},
	};
	return backend;
}
