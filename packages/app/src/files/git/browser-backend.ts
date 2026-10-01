/**
 * Browser Git storage: isomorphic-git over the folder's IndexedDB database.
 *
 * Refs are loose files in the `git` store. The branch moves only through a
 * conditional transaction that compares the stored ref with the pinned
 * value. Index and branch work holds a Web Lock (plus an in-process queue) so
 * tabs of the same origin do not interleave index writes. Network transfers
 * run outside the lock.
 */

import { createTwoFilesPatch } from 'diff';
import * as git from 'isomorphic-git';
import {
	applyInTransaction,
	type IndexedDbEnvironment,
	request,
	STORES,
	writeTransaction,
} from '../browser-store.js';
import type {
	CasResult,
	FastForwardPlan,
	GitBackend,
	GitRemote,
	PathStatus,
	StatusCode,
} from './backend.js';
import { createGitSession, GITDIR, WORKDIR } from './browser-fs.js';
import { abortableHttp } from './http.js';
import { commitTree, logCommits, type ObjectAccess } from './objects.js';
import { gitignoreMatcher } from './scope.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const REMOTE_NAME = 'origin';

class BranchMoved {
	constructor(readonly actual: string | undefined) {}
}

function createMutex() {
	let tail = Promise.resolve();
	return <T>(work: () => Promise<T>): Promise<T> => {
		const result = tail.then(work, work);
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	};
}

export async function createBrowserGitBackend({
	db,
	environment,
	lockName,
	branch,
	remote,
}: {
	db: IDBDatabase;
	environment: IndexedDbEnvironment;
	lockName: string;
	branch: string;
	remote: GitRemote | undefined;
}): Promise<GitBackend> {
	const branchKey = `${GITDIR}/refs/heads/${branch}`;
	const trackingKey = `${GITDIR}/refs/remotes/${REMOTE_NAME}/${remote?.branch ?? branch}`;
	const queue = createMutex();

	async function withObjects<T>(
		work: (access: ObjectAccess) => Promise<T>,
	): Promise<T> {
		const session = createGitSession(db, environment);
		const value = await work({ fs: session.fs, gitdir: GITDIR, cache: {} });
		await session.flush();
		return value;
	}

	async function readRef(key: string): Promise<string | undefined> {
		const value = (await request(
			db.transaction(STORES.git).objectStore(STORES.git).get(key),
		)) as Uint8Array | undefined;
		if (value === undefined) return undefined;
		const text = decoder.decode(value).trim();
		return /^[0-9a-f]{40}$/.test(text) ? text : undefined;
	}

	// Create the private repository once. Its configuration names the remote so
	// isomorphic-git records fetched and pushed heads as tracking refs.
	const initialized = await request(
		db.transaction(STORES.git).objectStore(STORES.git).get(`${GITDIR}/HEAD`),
	);
	if (initialized === undefined) {
		await withObjects(async ({ fs, gitdir }) => {
			await git.init({ fs, dir: WORKDIR, gitdir, defaultBranch: branch });
			await git.setConfig({
				fs,
				gitdir,
				path: 'core.autocrlf',
				value: 'false',
			});
		});
	}
	if (remote !== undefined)
		await withObjects(async ({ fs, gitdir }) => {
			await git.setConfig({
				fs,
				gitdir,
				path: `remote.${REMOTE_NAME}.url`,
				value: remote.url,
			});
			await git.setConfig({
				fs,
				gitdir,
				path: `remote.${REMOTE_NAME}.fetch`,
				value: `+refs/heads/*:refs/remotes/${REMOTE_NAME}/*`,
			});
		});

	async function exclusive<T>(work: () => Promise<T>): Promise<T> {
		return queue(async () => {
			const locks = (globalThis.navigator as Navigator | undefined)?.locks;
			if (locks === undefined) return work();
			return locks.request(lockName, work);
		});
	}

	async function casBranch(
		expected: string | undefined,
		next: string,
	): Promise<CasResult> {
		const result = await writeTransaction(db, [STORES.git], async (tx) => {
			const store = tx.objectStore(STORES.git);
			const value = (await request(store.get(branchKey))) as
				| Uint8Array
				| undefined;
			const actual =
				value === undefined ? undefined : decoder.decode(value).trim();
			if (actual !== expected) throw new BranchMoved(actual);
			store.put(encoder.encode(`${next}\n`), branchKey);
		});
		if (result.error) {
			const cause = result.error.name === 'Io' ? result.error.cause : undefined;
			if (cause instanceof BranchMoved)
				return { ok: false, actual: cause.actual };
			throw new Error(result.error.message);
		}
		return { ok: true };
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

	async function matrix(access: ObjectAccess, filepaths?: string[]) {
		const hasHead = (await readRef(branchKey)) !== undefined;
		if (!hasHead) {
			// isomorphic-git's statusMatrix needs a resolvable HEAD; compare the
			// index and working files against an empty history instead.
			const rows: [string, number, number, number][] = [];
			await git.walk({
				...access,
				dir: WORKDIR,
				trees: [git.STAGE(), git.WORKDIR()],
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
		});
	}

	async function blobText(
		access: ObjectAccess,
		oid: string | undefined,
	): Promise<{ text: string; binary: boolean }> {
		if (oid === undefined) return { text: '', binary: false };
		const { blob } = await git.readBlob({ ...access, oid });
		return { text: decoder.decode(blob), binary: blob.includes(0) };
	}

	const backend: GitBackend = {
		branch,
		remote,
		withObjects,
		exclusive,
		readBranch: () => readRef(branchKey),
		readRemoteTracking: () => readRef(trackingKey),
		casBranch,
		async blocked() {
			return undefined;
		},
		async checkpointProblem() {
			// Browser files are plain bytes with no modes, links, or filters.
			return undefined;
		},
		async reconcileIndex(commit) {
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
				return mismatched;
			});
		},
		async ignoredPaths(candidates, current) {
			const ignored = gitignoreMatcher(current);
			return new Set(candidates.filter((path) => ignored(path)));
		},
		async indexMatchesHead() {
			const rows = await withObjects((access) => matrix(access));
			return rows.every(([, head, , stage]) =>
				head === 0 ? stage === 0 : stage === 1,
			);
		},
		async pathStatus() {
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
			const session = createGitSession(db, environment);
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
				parent === undefined ? undefined : await commitTree(access, parent);
			const indexEntries = await git.listFiles({ ...access, dir: WORKDIR });
			if (
				tree === parentTree ||
				(parent === undefined && indexEntries.length === 0)
			)
				return { status: 'nothing' };
			await session.flush();
			const moved = await casBranch(parent, oid);
			if (!moved.ok) return { status: 'branchMoved', actual: moved.actual };
			return { status: 'committed', oid, parent };
		},
		async diff({ staged, paths }) {
			return withObjects(async (access) => {
				const head = await readRef(branchKey);
				const filepaths = paths.length === 0 ? undefined : [...paths];
				const outputs: string[] = [];
				const trees =
					head === undefined
						? [git.STAGE(), git.WORKDIR()]
						: [git.TREE({ ref: head }), git.STAGE(), git.WORKDIR()];
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
			await withObjects(async (access) => {
				const result = await git.push({
					...access,
					http: abortableHttp(signal),
					dir: WORKDIR,
					url: remote.url,
					remote: REMOTE_NAME,
					ref: oid,
					remoteRef: `refs/heads/${remote.branch}`,
					force: false,
				});
				const status = result.refs[`refs/heads/${remote.branch}`];
				if (!result.ok || (status && !status.ok))
					throw new Error(
						status?.error ?? result.error ?? 'The remote rejected the push',
					);
			});
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			return withObjects(async (access) => {
				try {
					const result = await git.fetch({
						...access,
						http: abortableHttp(signal),
						dir: WORKDIR,
						url: remote.url,
						remote: REMOTE_NAME,
						ref: remote.branch,
						remoteRef: remote.branch,
						singleBranch: true,
						tags: false,
					});
					return result.fetchHead ?? undefined;
				} catch (cause) {
					if (
						cause instanceof Error &&
						(cause as { code?: string }).code === 'NotFoundError' &&
						cause.message.includes(remote.branch)
					)
						return undefined;
					throw cause;
				}
			});
		},
		async publishFastForward(plan: FastForwardPlan) {
			// Compute index entries for the new head, then publish files, index,
			// and the branch in one transaction.
			const session = createGitSession(db, environment);
			for (const filepath of plan.paths)
				await git.resetIndex({
					fs: session.fs,
					dir: WORKDIR,
					gitdir: GITDIR,
					filepath,
					ref: plan.nextHead,
					cache: {},
				});
			const result = await writeTransaction(
				db,
				[STORES.inventory, STORES.contents, STORES.directories, STORES.git],
				async (tx) => {
					await applyInTransaction(tx, environment, plan.changes);
					const store = tx.objectStore(STORES.git);
					const value = (await request(store.get(branchKey))) as
						| Uint8Array
						| undefined;
					const actual =
						value === undefined ? undefined : decoder.decode(value).trim();
					if (actual !== plan.expectedHead) throw new BranchMoved(actual);
					session.flushInto(tx);
					store.put(encoder.encode(`${plan.nextHead}\n`), branchKey);
				},
			);
			if (result.error === null) return { status: 'published' };
			if (
				result.error.name === 'Io' &&
				result.error.cause instanceof BranchMoved
			)
				return {
					status: 'branchMoved',
					actual: result.error.cause.actual,
					filesApplied: false,
				};
			return { status: 'refused', error: result.error };
		},
	};
	return backend;
}
