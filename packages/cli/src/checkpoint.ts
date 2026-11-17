/** One root checkpoint for manual calls and the host schedule. Never imports apps. */
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isLocalPath, isName } from '@epicenter/app';
import { git, gitMessage } from './git.js';
import { type Held, hold } from './lock.js';

type Problem = { message: string; next?: string };
export type Checkpoint = {
	committed: { commit: string; files: number } | null;
	pushed: boolean;
	origin: { ahead: number } | null;
	deferred?: Problem;
	failed?: Problem;
	pushFailed?: Problem;
};

/** Accept a root only when Git's top is that folder, including through a symlink. */
export async function isRepositoryTop(root: string) {
	const top = await git(root, ['rev-parse', '--show-toplevel']);
	return (
		top.code === 0 && (await realpath(top.stdout)) === (await realpath(root))
	);
}

/** Status uses -z and --no-renames so every record holds exactly one path. */
function pendingPaths(stdout: string) {
	return stdout
		.split('\0')
		.filter(Boolean)
		.map((entry) => ({
			status: entry.slice(0, 2),
			path: entry.slice(3),
		}));
}

/** Git writers outside Epicenter share the index. Let brief collisions finish. */
async function retryGit(root: string, args: string[]) {
	const deadline = Date.now() + 2_000;
	for (;;) {
		const result = await git(root, args);
		if (
			result.code === 0 ||
			!/index\.lock/.test(result.stderr) ||
			Date.now() >= deadline
		)
			return result;
		await Bun.sleep(50);
	}
}

/** A deleted or renamed credential still belongs to the history being uploaded. */
async function unpushedLocalPath(root: string, range: string) {
	const history = await git(root, [
		'log',
		'-m',
		'--format=',
		'--name-only',
		'--diff-filter=AM',
		'--no-renames',
		'-z',
		range,
	]);
	if (history.code !== 0) throw new Error(gitMessage(['log'], history));
	return history.stdout.split('\0').find((path) => path && isLocalPath(path));
}

async function refusePending(
	root: string,
): Promise<(Problem & { trackedLocal?: true }) | undefined> {
	const status = await git(root, [
		'status',
		'--porcelain',
		'-z',
		'--untracked-files=all',
		'--no-renames',
	]);
	if (status.code !== 0) throw new Error(gitMessage(['status'], status));
	const pending = pendingPaths(status.stdout);
	for (const { status, path } of pending) {
		// A deletion in either column stages removal without including secret contents.
		if (isLocalPath(path) && !status.includes('D'))
			return status === '??'
				? {
						message: `${path} would be committed; add *.local and *.local.* to ${root}/.gitignore`,
					}
				: {
						trackedLocal: true,
						message: `${path} would be committed: Git already tracks it, so .gitignore cannot keep it out`,
						next: `git -C ${root} rm --cached -- ${path}`,
					};
		if (status === '??' && path.endsWith('/'))
			return embedded(path, 'move it out of the Epicenter or remove its .git');
	}
	const index = await git(root, ['ls-files', '-s', '-z']);
	if (index.code !== 0) throw new Error(gitMessage(['ls-files'], index));
	for (const entry of index.stdout.split('\0')) {
		if (entry.startsWith('160000 ')) {
			const path = entry.slice(entry.indexOf('\t') + 1);
			return embedded(path, `git -C ${root} rm --cached -- ${path}`);
		}
	}
	const tracked = await git(root, ['ls-files', '-z']);
	if (tracked.code !== 0) throw new Error(gitMessage(['ls-files'], tracked));
	for (const path of tracked.stdout.split('\0').filter(Boolean)) {
		if (
			isLocalPath(path) &&
			!pending.some(
				(entry) => entry.path === path && entry.status.includes('D'),
			)
		)
			return {
				trackedLocal: true,
				message: `${path} would be committed: Git already tracks it, so .gitignore cannot keep it out`,
				next: `git -C ${root} rm --cached -- ${path}`,
			};
	}
	const ignoredList = await git(root, [
		'ls-files',
		'--others',
		'--ignored',
		'--exclude-standard',
		'--directory',
		'-z',
	]);
	if (ignoredList.code !== 0)
		throw new Error(gitMessage(['ls-files'], ignoredList));
	const ignoredDirectories = new Set(
		ignoredList.stdout.split('\0').filter((path) => path.endsWith('/')),
	);
	const nested = await embeddedRepository(root, ignoredDirectories);
	if (nested)
		return embedded(
			`${nested}/`,
			'move it out of the Epicenter or remove its .git',
		);

	if (
		pending.length &&
		!(await git(root, ['config', '--get', 'filter.lfs.process'])).stdout
	) {
		const attributes = await git(
			root,
			['check-attr', '-z', '--stdin', 'filter'],
			{ input: `${pending.map(({ path }) => path).join('\0')}\0` },
		);
		if (attributes.code !== 0)
			throw new Error(gitMessage(['check-attr'], attributes));
		const fields = attributes.stdout.split('\0');
		for (let i = 0; i < fields.length - 2; i += 3) {
			if (fields[i + 2] === 'lfs')
				return {
					message: `${fields[i]} uses Git LFS, but its filter is not installed`,
					next: 'git lfs install',
				};
		}
	}
}

/** Search included real directories, including empty repositories Git status omits. */
async function embeddedRepository(
	root: string,
	ignoredDirectories: ReadonlySet<string>,
	prefix = '',
): Promise<string | undefined> {
	for (const entry of await readdir(join(root, prefix), {
		withFileTypes: true,
	})) {
		if (
			!entry.isDirectory() ||
			entry.name === '.git' ||
			entry.name === 'node_modules'
		)
			continue;
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (ignoredDirectories.has(`${path}/`)) continue;
		if (await lstat(join(root, path, '.git')).catch(() => undefined))
			return path;
		const nested = await embeddedRepository(root, ignoredDirectories, path);
		if (nested) return nested;
	}
}

function embedded(path: string, next: string): Problem {
	return {
		message: `${path} is a Git repository inside the Epicenter; a checkpoint would record only a pointer to it`,
		next,
	};
}

/** Upload only the inspected commit, independently of the local snapshot lock. */
async function backup(
	root: string,
	{ head, branch }: Pick<Snapshot, 'head' | 'branch'>,
	timeoutMs: number,
) {
	const result: Pick<Checkpoint, 'pushed' | 'origin' | 'pushFailed'> = {
		pushed: false,
		origin: null,
	};
	try {
		if (!head || (await git(root, ['remote', 'get-url', 'origin'])).code !== 0)
			return result;
		if (!branch) {
			result.pushFailed = { message: 'not on a branch, so nothing was pushed' };
			return result;
		}
		const tracking = await git(root, [
			'rev-parse',
			'--verify',
			`refs/remotes/origin/${branch}`,
		]);
		const range = tracking.code === 0 ? `${tracking.stdout}..${head}` : head;
		if (tracking.code === 0) {
			const ahead = await git(root, ['rev-list', '--count', range]);
			if (ahead.code !== 0) throw new Error(gitMessage(['rev-list'], ahead));
			result.origin = { ahead: Number(ahead.stdout) };
			if (result.origin.ahead === 0) return result;
		}
		const local = await unpushedLocalPath(root, range);
		if (local) {
			result.pushFailed = {
				message: `${local} is in commits not yet pushed, so a push would copy it to origin`,
				next: `git -C ${root} log --oneline ${range} -- ${local}`,
			};
			return result;
		}
		const args = ['push', 'origin', `${head}:refs/heads/${branch}`];
		const pushed = await git(root, args, { timeoutMs });
		if (pushed.timedOut) {
			result.pushFailed = {
				message: `push did not finish within ${timeoutMs === 600_000 ? '10 minutes' : `${timeoutMs / 1000} seconds`}; the deadline expired and the remote outcome is unconfirmed; the next pass safely retries with an ordinary non-force push`,
				next: `for a very large first push, run once by hand: git -C ${root} push origin ${head}:refs/heads/${branch}`,
			};
		} else if (pushed.code !== 0) {
			result.pushFailed = /non-fast-forward|fetch first/.test(pushed.stderr)
				? {
						message:
							'the backup at origin has changes this computer does not; nothing was overwritten',
						next: `git -C ${root} fetch origin && git -C ${root} log ${head}..origin/${branch}`,
					}
				: { message: gitMessage(args, pushed) };
		} else {
			result.pushed = true;
			result.origin = { ahead: 0 };
		}
	} catch (error) {
		result.pushFailed = {
			message: error instanceof Error ? error.message : String(error),
		};
	}
	return result;
}

/** Describe the staged paths, without guessing whether a change is finished. */
function checkpointMessage(paths: string[]) {
	const groups = new Set<string>();
	for (const path of paths) {
		const [root, app, kind] = path.split('/');
		groups.add(
			root !== 'apps'
				? 'root files'
				: !isName(app)
					? 'other files'
					: `${app} ${kind === 'code' ? 'code' : kind === 'data' ? 'records' : 'files'}`,
		);
	}
	const subject = `checkpoint: ${[...groups].sort().join(', ')}`;
	return subject.length <= 100 ? subject : `checkpoint: ${paths.length} files`;
}

/**
 * Stage all included root files and consume the shared index in one commit.
 * Capture HEAD and its branch before releasing the lock. No network work runs here.
 */
export async function snapshot(
	root: string,
	{ message }: { message?: string } = {},
) {
	const result: {
		committed: Checkpoint['committed'];
		head?: string;
		branch?: string;
		deferred?: Problem;
		failed?: Problem;
		trackedLocal?: boolean;
	} = { committed: null };
	let held: Held | undefined;
	try {
		if (!(await isRepositoryTop(root))) {
			result.failed = {
				message: `${root} is not a Git repository`,
				next: `git -C ${root} init`,
			};
			return result;
		}
		held = await hold(root, 30_000);
		if (!held) {
			result.deferred = { message: 'another checkpoint is running' };
			return result;
		}
		for (const state of [
			'MERGE_HEAD',
			'REVERT_HEAD',
			'CHERRY_PICK_HEAD',
			'rebase-merge',
			'rebase-apply',
			'sequencer',
		]) {
			const location = await git(root, [
				'rev-parse',
				'--path-format=absolute',
				'--git-path',
				state,
			]);
			if (location.code !== 0)
				throw new Error(gitMessage(['rev-parse'], location));
			if (
				await access(location.stdout).then(
					() => true,
					() => false,
				)
			) {
				result.deferred = {
					message:
						'a merge, rebase, revert, or cherry-pick is underway; finish or abort it first',
					next: `git -C ${root} status`,
				};
				return result;
			}
		}
		const refused = await refusePending(root);
		if (refused) {
			const { trackedLocal, ...problem } = refused;
			result.failed = problem;
			result.trackedLocal = trackedLocal;
		}
		const write = async (args: string[]) => {
			const ran = await retryGit(root, args);
			if (ran.code === 0) return true;
			if (/index\.lock/.test(ran.stderr))
				result.deferred = {
					message: `Git is busy: another process holds the index lock\n${gitMessage(args, ran)}`,
				};
			else result.failed = { message: gitMessage(args, ran) };
			return false;
		};
		let committedFiles: number | undefined;
		if (!refused && (await write(['add', '-A', '--', '.']))) {
			const changed = await git(root, [
				'diff',
				'--cached',
				'--name-only',
				'--no-renames',
				'-z',
			]);
			if (changed.code !== 0) throw new Error(gitMessage(['diff'], changed));
			const paths = changed.stdout.split('\0').filter(Boolean);
			if (
				paths.length &&
				(await write([
					'commit',
					'-q',
					'-m',
					message ?? checkpointMessage(paths),
				]))
			)
				committedFiles = paths.length;
		}
		const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
		if (head.code === 0) {
			result.head = head.stdout;
			if (committedFiles !== undefined)
				result.committed = { commit: head.stdout, files: committedFiles };
			result.branch = (
				await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
			).stdout;
		}
	} catch (error) {
		result.failed = {
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		held?.release();
	}
	return result;
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** Save locally, then retry the private backup without holding the repository lock. */
export async function checkpoint(
	root: string,
	{
		message,
		pushTimeoutMs = 600_000,
	}: { message?: string; pushTimeoutMs?: number } = {},
): Promise<Checkpoint> {
	const saved = await snapshot(root, { message });
	const result: Checkpoint = {
		committed: saved.committed,
		pushed: false,
		origin: null,
	};
	if (saved.deferred) result.deferred = saved.deferred;
	if (saved.failed) result.failed = saved.failed;
	if (!saved.deferred && !saved.trackedLocal)
		Object.assign(result, await backup(root, saved, pushTimeoutMs));
	return result;
}

/** Text output also serves callers that need to show a manual checkpoint result. */
export function renderCheckpoint(result: Checkpoint) {
	const lines = [
		result.committed
			? `checkpoint: committed ${result.committed.files} files (${result.committed.commit.slice(0, 7)})`
			: 'checkpoint: nothing to commit',
	];
	if (result.pushed) lines.push('pushed');
	lines.push(
		result.origin
			? `${result.origin.ahead} ahead of origin`
			: 'no origin or no tracking ref',
	);
	for (const problem of [result.deferred, result.failed, result.pushFailed]) {
		if (problem) {
			lines.push(problem.message);
			if (problem.next) lines.push(`Run: ${problem.next}`);
		}
	}
	return lines.join('\n');
}
