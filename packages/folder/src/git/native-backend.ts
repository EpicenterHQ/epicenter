/**
 * Native Git storage: a real repository in `<root>/.git`.
 *
 * isomorphic-git writes immutable objects for checkpoints (atomically, via a
 * scratch file and rename). Everything that mutates shared state uses the
 * real `git` CLI, whose `index.lock` and ref locks other Git processes
 * respect: `update-ref` with an expected old value is the branch
 * compare-and-swap, and `reset` and `update-index` update index entries.
 * isomorphic-git never writes the native index.
 *
 * A merge with conflicts is never left in the folder: the folder never
 * writes `MERGE_HEAD`, and one another Git program began blocks commits and
 * incoming updates until it is finished or abandoned with Git.
 */
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type * as git from 'isomorphic-git';
import type { FileBoundary } from '../boundary.js';
import { byCodePoint, NORMALIZING } from './attributes.js';
import type {
	GitBackend,
	GitRemote,
	PathStatus,
	PublishResult,
	StatusCode,
} from './backend.js';
import { capturedIndexMatchesHead } from './captured-index.js';
import { createMutex } from './mutex.js';
import { nativeCheckpointProblem } from './native-checkpoint.js';
import { type CommitSummary, type ObjectAccess } from './objects.js';

const ZERO = '0000000000000000000000000000000000000000';
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
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

/**
 * Inherited variables that would point Git at another repository, index, or
 * object store: the names `git rev-parse --local-env-vars` lists, plus the
 * ref namespace. Each command addresses the repository in its working
 * directory, whatever the parent process had set. The ceiling stops discovery
 * at the root, so a root whose `.git` is missing never resolves to a
 * repository in a directory above it. `GIT_OPTIONAL_LOCKS=0` keeps read-only
 * commands such as `status` and `diff` from taking `index.lock` to refresh
 * the index, so observing the folder never looks like a change to it.
 */
const REPOSITORY_ENV =
	/^GIT_(DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|GRAFT_FILE|SHALLOW_FILE|NO_REPLACE_OBJECTS|REPLACE_REF_BASE|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

function gitEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env))
		if (!REPOSITORY_ENV.test(name)) env[name] = value;
	return {
		...env,
		GIT_CEILING_DIRECTORIES: dirname(root),
		GIT_OPTIONAL_LOCKS: '0',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
}

export function createGitRunner(root: string): GitRun {
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = spawn('git', [...args], {
				cwd: root,
				env: { ...gitEnvironment(root), ...options.env },
				stdio: ['pipe', 'pipe', 'pipe'],
				signal: options.signal,
			});
			const stdout: Uint8Array[] = [];
			const stderr: Uint8Array[] = [];
			child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
			child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
			child.on('error', reject);
			child.on('close', (code) => {
				const out = Buffer.concat(stdout);
				const err = Buffer.concat(stderr).toString('utf8');
				if (code !== 0 && !options.allowFailure)
					reject(new GitCommandError(args, code, err));
				else resolve({ code, stdout: new Uint8Array(out), stderr: err });
			});
			child.stdin.on('error', () => {});
			if (options.input !== undefined) child.stdin.end(options.input);
			else child.stdin.end();
		});
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

/** A node filesystem whose writes land atomically, for isomorphic-git object writes. */
function atomicObjectFs(): git.PromiseFsClient {
	const promises = {
		...nodeFs.promises,
		async writeFile(
			path: string,
			data: Uint8Array | string,
			options?: unknown,
		) {
			const temporary = `${path}.tmp-${crypto.randomUUID()}`;
			await writeFile(temporary, data, options as never);
			await rename(temporary, path);
		},
	};
	return { promises } as unknown as git.PromiseFsClient;
}

export async function createNativeGitBackend({
	root,
	branch,
	remote,
	boundary,
}: {
	root: string;
	branch: string;
	remote: GitRemote | undefined;
	boundary: FileBoundary;
}): Promise<GitBackend> {
	const run = createGitRunner(root);
	const gitdir = join(root, '.git');
	const access: ObjectAccess = { fs: atomicObjectFs(), gitdir };
	const branchRef = `refs/heads/${branch}`;
	const trackingRef = `refs/remotes/${REMOTE_NAME}/${remote?.branch ?? branch}`;

	const isRepository = await stat(join(gitdir, 'HEAD')).then(
		() => true,
		() => false,
	);
	if (!isRepository)
		await run(['init', '--quiet', `--initial-branch=${branch}`]);

	// This handle's own work only. Another process is met at Git's lock
	// files, where a held lock fails the command instead of delaying it.
	const queue = createMutex();

	async function resolve(ref: string): Promise<string | undefined> {
		const result = await run(
			['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
			{
				allowFailure: true,
			},
		);
		if (result.code !== 0) return undefined;
		return text(result.stdout).trim();
	}

	const literal = ['--literal-pathspecs'];

	/** Reset the named index entries without changing working files. */
	async function syncIndex(commit: string, paths: readonly string[]) {
		if (paths.length === 0) return;
		await run(
			[
				...literal,
				'reset',
				'--quiet',
				commit,
				'--pathspec-from-file=-',
				'--pathspec-file-nul',
			],
			{ input: `${paths.join('\0')}\0` },
		);
	}

	/** A private Git file's bytes, or `undefined` when there is none. */
	async function readPrivate(name: string): Promise<Uint8Array | undefined> {
		try {
			return new Uint8Array(await readFile(join(gitdir, name)));
		} catch (cause) {
			if ((cause as { code?: string }).code === 'ENOENT') return undefined;
			throw cause;
		}
	}

	function parsePorcelain(output: Uint8Array): PathStatus[] {
		const tokens = text(output).split('\0');
		const result: PathStatus[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!;
			if (token.length < 4) continue;
			const indexCode = token[0] as StatusCode;
			const worktreeCode = token[1] as StatusCode;
			const path = token.slice(3);
			if (indexCode === 'R' || indexCode === 'C') index++;
			result.push({ path, index: indexCode, worktree: worktreeCode });
		}
		return result;
	}

	const backend: GitBackend = {
		branch,
		remote,
		async withObjects(work) {
			return work(access);
		},
		exclusive: queue.run,
		readBranch: () => resolve(branchRef),
		readRemoteTracking: () => resolve(trackingRef),
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
			const head = await run(['symbolic-ref', '--quiet', 'HEAD'], {
				allowFailure: true,
			});
			if (head.code !== 0) return 'HEAD is detached';
			if (text(head.stdout).trim() !== branchRef)
				return `HEAD is not on ${branch}`;
			// The folder never begins a merge; one another Git program began is
			// finished or abandoned with Git.
			for (const marker of [
				'MERGE_HEAD',
				'CHERRY_PICK_HEAD',
				'REVERT_HEAD',
				'rebase-merge',
				'rebase-apply',
				'BISECT_LOG',
			]) {
				const present = await stat(join(gitdir, marker)).then(
					() => true,
					() => false,
				);
				if (present) return `a Git operation is in progress (${marker})`;
			}
			return undefined;
		},
		async checkpointProblem() {
			return nativeCheckpointProblem({
				root,
				run,
				head: await resolve(branchRef),
				ignored: (paths) => backend.ignoredPaths(paths, new Map()),
			});
		},
		async incomingAttribute(commit, files) {
			if (files.size === 0) return undefined;
			// Git's own attribute matching, against the commit's tree alone. A
			// Git too old for `--source` fails here, before anything is written.
			const result = await run(
				['check-attr', `--source=${commit}`, '--stdin', '-z', ...NORMALIZING],
				{ input: `${[...files.keys()].sort(byCodePoint).join('\0')}\0` },
			);
			const records = text(result.stdout).split('\0');
			for (let index = 0; index + 2 < records.length; index += 3) {
				const [path, attribute, value] = records.slice(index, index + 3);
				if (value !== 'unspecified' && value !== 'unset')
					return {
						path: path!,
						attribute: value === 'set' ? attribute! : `${attribute}=${value}`,
					};
			}
			return undefined;
		},
		async reconcileIndex(commit) {
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
		async ignoredPaths(candidates) {
			// `--no-index` evaluates the rules alone; the caller keeps tracked files.
			const result = await run(
				['check-ignore', '--no-index', '--stdin', '-z'],
				{ input: `${candidates.join('\0')}\0`, allowFailure: true },
			);
			if (result.code !== 0 && result.code !== 1)
				throw new GitCommandError(['check-ignore'], result.code, result.stderr);
			return new Set(text(result.stdout).split('\0').filter(Boolean));
		},
		async indexMatchesHead(captured) {
			return backend.withObjects((access) =>
				capturedIndexMatchesHead(access, captured),
			);
		},
		readIndex: () => readPrivate('index'),
		async pathStatus() {
			const result = await run([
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			]);
			return parsePorcelain(result.stdout);
		},
		async diff(paths) {
			const result = await run([
				...literal,
				'diff',
				'--no-color',
				'--no-ext-diff',
				'--',
				...paths,
			]);
			return text(result.stdout);
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
			await run(
				[
					'push',
					'--porcelain',
					remote.url,
					`${oid}:refs/heads/${remote.branch}`,
				],
				{ signal },
			);
			await run(['update-ref', trackingRef, oid]);
		},
		async fetch(signal) {
			if (remote === undefined) throw new Error('No remote is configured');
			const result = await run(
				[
					'fetch',
					'--no-tags',
					'--quiet',
					remote.url,
					`+refs/heads/${remote.branch}:${trackingRef}`,
				],
				{ signal, allowFailure: true },
			);
			if (result.code !== 0) {
				if (/couldn't find remote ref/i.test(result.stderr)) return undefined;
				throw new GitCommandError(['fetch'], result.code, result.stderr);
			}
			return resolve(trackingRef);
		},
		// The baseline is not checked here: each step carries its own file
		// condition, and other programs are met only at Git's lock files.
		async publishIncoming(plan): Promise<PublishResult> {
			const { error: applyError } = await boundary.apply(plan.changes);
			if (applyError !== null) {
				if (applyError.name === 'Partial')
					return {
						status: 'partial',
						applied: applyError.applied,
						error: applyError.error,
					};
				return { status: 'refused', error: applyError };
			}
			try {
				await syncIndex(plan.nextHead, plan.paths);
			} catch (cause) {
				return {
					status: 'indexFailed',
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
			const moved = await backend.casBranch(plan.expectedHead, plan.nextHead);
			if (!moved.ok)
				return {
					status: 'branchMoved',
					actual: moved.actual,
					filesApplied: true,
				};
			return { status: 'published' };
		},
	};
	return backend;
}
