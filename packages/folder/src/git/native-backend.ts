/**
 * Native Git storage: a real repository in `<root>/.git`.
 *
 * isomorphic-git builds checkpoint trees and commits, and every object it
 * writes is stored by `git hash-object -w`, so nothing writes an object file
 * by hand. Everything that mutates shared state uses the real `git` CLI,
 * whose `index.lock` and ref locks other Git processes respect: `update-ref`
 * with an expected old value is the branch compare-and-swap, and `reset`
 * updates index entries. isomorphic-git never writes the native index.
 *
 * A merge with conflicts is never left in the folder: the folder never
 * writes `MERGE_HEAD`, and one another Git program began blocks commits and
 * Sync's publishing until it is finished or abandoned with Git.
 *
 * A commit pins its parent first, the branch head, writes its tree and
 * itself as objects, and moves the branch from that parent by
 * compare-and-swap; `git commit` would take whatever `HEAD` names when it
 * runs. A commit runs no commit hooks and is not signed.
 *
 * The backend reaches the machine only through its host: a `git` runner and
 * directory primitives, which `native-host.ts` supplies in Bun and Node. A
 * desktop page runs none of this: the `epicenter` CLI runs it (ADR-0559,
 * `runHistory` in `bun.ts`).
 */
import type { DirectoryPrimitives } from '../directory-primitives.js';
import { type GitBackend, type GitRemote, REMOTE_MOVED } from './backend.js';
import { basicAuthorization, type GitCredentials } from './http.js';
import { createMutex } from './mutex.js';
import { nativeCheckpointProblem } from './native-checkpoint.js';
import { neutralizeAttributes } from './neutral-attributes.js';
import type { CommitSummary, ObjectAccess } from './objects.js';
import { primitiveFs } from './primitive-fs.js';
import { gitignoreMatcher } from './scope.js';

const ZERO = '0000000000000000000000000000000000000000';
const PUBLISHING_REF = 'refs/epicenter/publishing';
const REMOTE_NAME = 'origin';

export class GitCommandError extends Error {
	constructor(
		readonly args: readonly string[],
		readonly code: number | null,
		readonly stderr: string,
	) {
		super(
			stderr.trim() === ''
				? `git ${args[0]} exited with ${code}`
				: `git ${args[0]}: ${stderr.trim()}`,
		);
		this.name = 'GitCommandError';
	}
}

export type GitRun = (
	args: readonly string[],
	options?: {
		input?: Uint8Array | string;
		signal?: AbortSignal;
		allowFailure?: boolean;
		env?: Readonly<Record<string, string>>;
		/**
		 * An `Authorization` header for a push or fetch, sent only to `url`,
		 * which is the remote the command names. The host passes it to Git
		 * outside its arguments.
		 */
		credential?: GitAuthorization;
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

/** One `Authorization` header value, for exactly one URL. */
type GitAuthorization = {
	readonly url: string;
	readonly authorization: string;
};

/**
 * The Git configuration that sends `credential`'s header to its URL alone,
 * follows no redirect, and asks no credential helper, as environment
 * variables, so the header never appears in a process list. Redirects are
 * refused for the URL too: Git prefers a URL-specific
 * `http.<url>.followRedirects` from any other configuration over a plain
 * `http.followRedirects`.
 */
export function credentialEnvironment({
	url,
	authorization,
}: GitAuthorization): Record<string, string> {
	if (!/^(Basic|Bearer) [\x21-\x7e]+$/.test(authorization))
		throw new Error('A Git credential must be one Basic or Bearer header');
	return {
		GIT_CONFIG_COUNT: '4',
		GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
		GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
		GIT_CONFIG_KEY_1: 'http.followRedirects',
		GIT_CONFIG_VALUE_1: 'false',
		GIT_CONFIG_KEY_2: `http.${url}.followRedirects`,
		GIT_CONFIG_VALUE_2: 'false',
		GIT_CONFIG_KEY_3: 'credential.helper',
		GIT_CONFIG_VALUE_3: '',
	};
}

/** How the backend reaches the machine. */
export type NativeGitHost = {
	/** Runs `git` in the folder's root, with the repository-pinning environment. */
	readonly run: GitRun;
	/** The file system, with absolute paths. */
	readonly files: DirectoryPrimitives;
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function createNativeGitBackend({
	root,
	branch,
	host,
	credentials,
	initialized,
	initProblem,
}: {
	root: string;
	branch: string;
	host: NativeGitHost;
	/**
	 * Runs once `git init` has created the repository. A folder with no
	 * repository gets one with its first commit (`createRepository`), or
	 * when a remote is set, never when it opens;
	 * until then it reads as an empty history with every file uncommitted,
	 * and no `git` runs.
	 */
	initialized?: () => Promise<void>;
	/**
	 * Why `git init` must not run here, such as a root inside
	 * another repository's working tree. `createRepository` answers it, and
	 * setting a remote throws it.
	 */
	initProblem?: () => Promise<string | undefined>;
	/** Asked before each push and fetch; see `GitCredentials`. */
	credentials?: GitCredentials;
}): Promise<GitBackend> {
	const { run, files } = host;
	const gitdir = `${root}/.git`;
	// Objects are stored by `git hash-object -w`, which names and checks
	// each one; nothing writes an object file by hand. Hashing from standard
	// input with no `--path` applies no attribute and no line-ending
	// conversion, which is what commits each file with the bytes it has on
	// disk, whatever the repository's or the person's attributes say.
	const access: ObjectAccess = {
		fs: primitiveFs(files, {
			gitdir,
			async write(type, content) {
				const { stdout } = await run(
					['hash-object', '-w', '-t', type, '--stdin'],
					{ input: content },
				);
				return text(stdout).trim();
			},
		}),
		gitdir,
	};
	const branchRef = `refs/heads/${branch}`;
	/** The credential for `url`, asked for each transfer. */
	async function authorize(
		url: string,
		signal: AbortSignal,
	): Promise<GitAuthorization | undefined> {
		const credential = await credentials?.(url, signal);
		signal.throwIfAborted();
		return credential === undefined
			? undefined
			: { url, authorization: basicAuthorization(credential) };
	}
	const trackingRef = `refs/remotes/${REMOTE_NAME}/${branch}`;

	// Folder saves stage beside the root and create no Git repository.
	// A `.git` directory alone does not show whether `git init` finished.
	const head = `${gitdir}/HEAD`;
	// Two openers that create one repository at once race Git's copy of its
	// templates, and the one that loses fails on a file the other just made.
	// Running `git init` again finds the repository and skips what exists.
	const init = async () => {
		const args = ['init', '--quiet', `--initial-branch=${branch}`];
		try {
			await run(args);
		} catch {
			await run(args);
		}
	};
	let present = (await files.lstat(head)) !== undefined;
	/** Whether the repository exists. Another program may have created it. */
	async function exists(): Promise<boolean> {
		present ||= (await files.lstat(head)) !== undefined;
		return present;
	}
	/**
	 * Create the repository if there is none, with attributes that change no
	 * bytes (`neutralizeAttributes`); see `initialized`. Answers why it may
	 * not be created here, having run nothing.
	 */
	async function createRepository(): Promise<string | undefined> {
		if (await exists()) return undefined;
		const problem = await initProblem?.();
		if (problem !== undefined) return problem;
		// First, since `git init` keeps it: a repository is never there
		// without it, even when this process stops between the two.
		await neutralizeAttributes(files, gitdir);
		await init();
		present = true;
		await initialized?.();
		return undefined;
	}
	/** Create the repository for a write that needs one, or throw why not. */
	async function repository() {
		const problem = await createRepository();
		if (problem !== undefined) throw new Error(problem);
	}

	/** The remote Git configuration names: `remote.origin.url`, on this branch. */
	async function configuredRemote(): Promise<GitRemote | undefined> {
		if (!(await exists())) return undefined;
		const { code, stdout } = await run(
			['config', '--get', `remote.${REMOTE_NAME}.url`],
			{ allowFailure: true },
		);
		const url = text(stdout).trim();
		return code === 0 && url !== '' ? { url, branch } : undefined;
	}
	let remote = await configuredRemote();

	// This handle's own work only. Another handle or process is met at Git's
	// lock files, where a held lock fails the command instead of delaying it,
	// and at the branch's compare-and-swap (ADR-0541).
	const serialized: GitBackend['exclusive'] = createMutex().run;

	async function resolve(ref: string): Promise<string | undefined> {
		if (!(await exists())) return undefined;
		const result = await run(
			['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
			{
				allowFailure: true,
			},
		);
		if (result.code !== 0) return undefined;
		return text(result.stdout).trim();
	}

	/** Reset the named index entries without changing working files. */
	async function syncIndex(commit: string, paths: readonly string[]) {
		if (paths.length === 0) return;
		await run(
			[
				'--literal-pathspecs',
				'reset',
				'--quiet',
				commit,
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			],
			{ input: `${paths.join('\0')}\0` },
		);
	}

	const backend: GitBackend = {
		createRepository,
		branch,
		get remote() {
			return remote;
		},
		async refreshRemote() {
			remote = await configuredRemote();
			return remote;
		},
		async setRemote(url) {
			await repository();
			await run(['config', `remote.${REMOTE_NAME}.url`, url]);
			remote = { url, branch };
			return remote;
		},
		async withObjects(work) {
			return work(access);
		},
		exclusive: serialized,
		readBranch: () => resolve(branchRef),
		readRemoteTracking: () => resolve(trackingRef),
		readPublishing: () => resolve(PUBLISHING_REF),
		async writePublishing(oid) {
			await run(
				oid === undefined
					? ['update-ref', '-d', PUBLISHING_REF]
					: ['update-ref', '-m', 'epicenter: publishing', PUBLISHING_REF, oid],
			);
		},
		async casBranch(expected, next) {
			const result = await run(
				[
					'update-ref',
					'-m',
					'epicenter: commit',
					branchRef,
					next,
					expected ?? ZERO,
				],
				{ allowFailure: true },
			);
			if (result.code === 0) return { ok: true };
			const actual = await resolve(branchRef);
			if (actual !== expected) return { ok: false, actual };
			throw new GitCommandError(['update-ref'], result.code, result.stderr);
		},
		async blocked() {
			// No repository has no operation in progress.
			if (await exists()) {
				const head = await run(['symbolic-ref', '--quiet', 'HEAD'], {
					allowFailure: true,
				});
				if (head.code !== 0) return 'HEAD is detached';
				if (text(head.stdout).trim() !== branchRef)
					return `HEAD is not on ${branch}`;
				// The folder never begins a merge; one another Git program began
				// is finished or abandoned with Git.
				for (const marker of [
					'MERGE_HEAD',
					'CHERRY_PICK_HEAD',
					'REVERT_HEAD',
					'rebase-merge',
					'rebase-apply',
					'BISECT_LOG',
				]) {
					const present =
						(await files.lstat(`${gitdir}/${marker}`)) !== undefined;
					if (present) return `a Git operation is in progress (${marker})`;
				}
			}
			return nativeCheckpointProblem({
				root,
				run,
				files,
				head: await resolve(branchRef),
				ignored: (paths) => backend.ignoredPaths(paths, new Map()),
			});
		},
		async reconcileIndex(commit) {
			if (!(await exists())) return;
			// `diff-index --cached` lists every index entry that differs from the
			// tree, including staged-only additions and deletions.
			const differing = await run([
				'diff-index',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
				commit,
			]);
			const paths = text(differing.stdout).split('\0').filter(Boolean);
			await syncIndex(commit, paths);
		},
		async ignoredPaths(candidates, current) {
			// With no repository there is no `git` to ask: the folder's own
			// `.gitignore` files decide. Its first commit creates the
			// repository and asks `git` first.
			if (!(await exists())) {
				const ignored = gitignoreMatcher(current);
				return new Set(candidates.filter((path) => ignored(path)));
			}
			// `--no-index` evaluates the rules alone; the caller keeps tracked files.
			const result = await run(
				['check-ignore', '--no-index', '--stdin', '-z'],
				{ input: `${candidates.join('\0')}\0`, allowFailure: true },
			);
			if (result.code !== 0 && result.code !== 1)
				throw new GitCommandError(['check-ignore'], result.code, result.stderr);
			return new Set(text(result.stdout).split('\0').filter(Boolean));
		},
		async log(depth): Promise<CommitSummary[]> {
			if ((await resolve(branchRef)) === undefined) return [];
			const result = await run([
				'log',
				`-n${depth}`,
				'--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e',
				branchRef,
			]);
			return text(result.stdout)
				.split('\x1e')
				.map((record) => record.replace(/^\n/, ''))
				.filter((record) => record.trim() !== '')
				.map((record) => {
					const [oid, parents, name, email, timestamp, message] =
						record.split('\x1f');
					return {
						oid: oid!,
						parents: parents ? parents.split(' ') : [],
						message: message ?? '',
						author: {
							name: name!,
							email: email!,
							timestamp: Number(timestamp),
						},
					};
				});
		},
		async push(oid, signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const credential = await authorize(remote.url, signal);
			const pushed = await run(
				[
					'push',
					'--porcelain',
					remote.url,
					`${oid}:refs/heads/${remote.branch}`,
				],
				{ signal, credential, allowFailure: true },
			);
			if (pushed.code !== 0) {
				// `--porcelain` marks a ref the remote refused to move by a
				// fast-forward with `!` and `[rejected]`, and one that moved after
				// the remote advertised it with `[remote rejected]` and the
				// remote's reason.
				const refused = text(pushed.stdout)
					.split('\n')
					.filter((line) => line.startsWith('!\t'));
				if (
					refused.some(
						(line) =>
							line.includes('\t[rejected]') ||
							(line.includes('[remote rejected]') && REMOTE_MOVED.test(line)),
					)
				)
					return 'rejected';
				throw new GitCommandError(['push'], pushed.code, pushed.stderr);
			}
			await run(['update-ref', trackingRef, oid]);
			return 'pushed';
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const credential = await authorize(remote.url, signal);
			const result = await run(
				[
					'fetch',
					'--no-tags',
					'--quiet',
					remote.url,
					`+refs/heads/${remote.branch}:${trackingRef}`,
				],
				{ signal, allowFailure: true, credential },
			);
			if (result.code !== 0) {
				if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
				throw new GitCommandError(['fetch'], result.code, result.stderr);
			}
			return resolve(trackingRef);
		},
	};
	return backend;
}
