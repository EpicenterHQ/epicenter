/**
 * Native Git storage: a real repository in `<root>/.git`.
 *
 * isomorphic-git writes immutable objects for checkpoints (atomically, via a
 * scratch file and rename). Everything that mutates shared state uses the
 * real `git` CLI, whose `index.lock` and ref locks other Git processes
 * respect: `update-ref` with an expected old value is the branch
 * compare-and-swap, `reset` updates index entries, and staging and staged
 * commits run `git add` and `git commit`. isomorphic-git never writes the
 * native index.
 */
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type * as git from 'isomorphic-git';
import type { FileBoundary } from '../boundary.js';
import type {
	GitBackend,
	GitRemote,
	PathStatus,
	PublishResult,
	StatusCode,
} from './backend.js';
import { nativeCheckpointProblem } from './native-checkpoint.js';
import type { CommitSummary, ObjectAccess } from './objects.js';

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
	},
) => Promise<{ code: number | null; stdout: Uint8Array; stderr: string }>;

export function createGitRunner(root: string): GitRun {
	return (args, options = {}) =>
		new Promise((resolve, reject) => {
			const child = spawn('git', [...args], {
				cwd: root,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
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

	let tail = Promise.resolve();
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const result = tail.then(work, work);
		tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

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
		exclusive,
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
			return paths;
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
		async indexMatchesHead() {
			const head = await resolve(branchRef);
			const result = await run(
				head === undefined
					? ['ls-files', '--cached', '-z']
					: ['diff', '--cached', '--quiet', '--no-ext-diff'],
				{ allowFailure: true },
			);
			if (head === undefined)
				return result.code === 0 && result.stdout.byteLength === 0;
			if (result.code === 0) return true;
			if (result.code === 1) return false;
			throw new GitCommandError(['diff'], result.code, result.stderr);
		},
		async pathStatus() {
			const result = await run([
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
			]);
			return parsePorcelain(result.stdout);
		},
		async stage(paths) {
			if (paths === 'all') await run(['add', '--all']);
			else await run([...literal, 'add', '--all', '--', ...paths]);
		},
		async commitIndex(message, author) {
			const parent = await resolve(branchRef);
			const staged = await backend.indexMatchesHead();
			if (staged) return { status: 'nothing' };
			const result = await run(
				[
					'-c',
					`user.name=${author.name}`,
					'-c',
					`user.email=${author.email}`,
					'commit',
					'--quiet',
					'--no-edit',
					'--cleanup=verbatim',
					'--file=-',
				],
				{ input: message, allowFailure: true },
			);
			const head = await resolve(branchRef);
			if (result.code !== 0) {
				if (head !== parent) return { status: 'branchMoved', actual: head };
				throw new GitCommandError(['commit'], result.code, result.stderr);
			}
			if (head === undefined)
				throw new Error('git commit succeeded without a branch head');
			return { status: 'committed', oid: head, parent };
		},
		async diff({ staged, paths }) {
			const result = await run([
				...literal,
				'diff',
				'--no-color',
				'--no-ext-diff',
				...(staged ? ['--cached'] : []),
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
		async publishFastForward(plan): Promise<PublishResult> {
			const applied = await boundary.apply(plan.changes);
			if (applied.error) {
				if (applied.error.name === 'Partial')
					return {
						status: 'partial',
						applied: applied.error.applied,
						error: applied.error.error,
					};
				return { status: 'refused', error: applied.error };
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
