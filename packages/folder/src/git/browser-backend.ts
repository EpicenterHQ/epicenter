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
import type { CasResult, GitBackend, GitRemote } from './backend.js';
import {
	abortableHttp,
	basicAuthorization,
	type GitCredentials,
	type HttpFetch,
} from './http.js';
import { orphanStagesProblem, parseIndex } from './index-file.js';
import { logCommits, type ObjectAccess, readBlob } from './objects.js';
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
};

/** isomorphic-git's view of private Git state. */
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
 * A backend over a private repository it creates when first needed: by the
 * first Git write (a commit, staging, or setting a remote), never by
 * opening or a file save. Until then reads find no history.
 */
/**
 * How a remote refuses a push because its branch moved since this folder
 * fetched: not a fast-forward, or, when it moved after the remote advertised
 * it, the remote's own update of the branch failing.
 */
const MOVED = /non-fast-forward|fetch first|failed to update ref/i;

export async function createStoredGitBackend<TSession extends GitFsSession>({
	store,
	locks,
	lockName,
	createLock,
	branch,
	httpFetch,
	credentials,
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
	credentials?: GitCredentials;
}): Promise<GitBackend> {
	const branchKey = `${GITDIR}/refs/heads/${branch}`;
	const indexKey = `${GITDIR}/index`;
	const mergeHeadKey = `${GITDIR}/MERGE_HEAD`;
	const trackingKey = `${GITDIR}/refs/remotes/${REMOTE_NAME}/${branch}`;

	/** The credential for `url`, asked for each transfer, as a header. */
	async function authorizationHeaders(
		url: string,
		signal: AbortSignal,
	): Promise<Record<string, string> | undefined> {
		const credential = await credentials?.(url, signal);
		signal.throwIfAborted();
		return credential === undefined
			? undefined
			: { authorization: basicAuthorization(credential) };
	}

	async function withObjects<T>(
		work: (access: ObjectAccess) => Promise<T>,
	): Promise<T> {
		const session = store.session();
		const value = await work({ fs: session.fs, gitdir: GITDIR, cache: {} });
		await session.flush();
		return value;
	}

	const readRef = async (key: string) => refValue(await store.readPrivate(key));

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
	/** Whether there is a repository to read. A read never creates one. */
	const available = created;
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
		await ensureCreated();
		return store.casRef(branchKey, expected, next);
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

	const backend: GitBackend = {
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
		async blocked() {
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
		async log(depth) {
			const head = await readRef(branchKey);
			if (head === undefined) return [];
			return withObjects((access) => logCommits(access, head, depth));
		},
		async push(oid, signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const { url, branch: remoteBranch } = remote;
			const headers = await authorizationHeaders(url, signal);
			return withObjects(async (access): Promise<'pushed' | 'rejected'> => {
				let result: Awaited<ReturnType<typeof git.push>>;
				try {
					result = await git.push({
						...access,
						http: abortableHttp(signal, httpFetch),
						headers,
						dir: WORKDIR,
						url: url,
						remote: REMOTE_NAME,
						ref: oid,
						remoteRef: `refs/heads/${remoteBranch}`,
						force: false,
					});
				} catch (cause) {
					// isomorphic-git refuses a push that is not a fast-forward itself,
					// before it sends the update, and its own message advises
					// forcing, which a folder never does.
					if (
						cause instanceof git.Errors.PushRejectedError &&
						cause.data.reason === 'not-fast-forward'
					)
						return 'rejected';
					// The remote moved the branch after it advertised it.
					if (
						cause instanceof git.Errors.GitPushError &&
						MOVED.test(
							cause.data.result.refs[`refs/heads/${remoteBranch}`]?.error ?? '',
						)
					)
						return 'rejected';
					throw cause;
				}
				const status = result.refs[`refs/heads/${remoteBranch}`];
				if (result.ok && (status === undefined || status.ok)) return 'pushed';
				if (MOVED.test(status?.error ?? '')) return 'rejected';
				throw new Error(
					status?.error ?? result.error ?? 'The remote rejected the push',
				);
			});
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const { url, branch: remoteBranch } = remote;
			await ensureCreated();
			const headers = await authorizationHeaders(url, signal);
			return withObjects(async (access) => {
				try {
					const result = await git.fetch({
						...access,
						http: abortableHttp(signal, httpFetch),
						headers,
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
	};
	return backend;
}
