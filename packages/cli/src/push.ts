/**
 * `origin` is an app's one remote, its meeting point and its backup
 * (ADR-0851). `epicenter` never pulls and never merges: after each commit it
 * makes, it pushes the branch fast-forward to the branch of the same name on
 * `origin`, and only when that is the branch it tracks. A worktree branch made
 * from `origin/main` tracks `origin/main` but is not `main`, so its commits
 * stay local. When the push cannot fast-forward, the commit stays local and
 * leaves with a later push; Git's unpushed commits are the only queue.
 */
import { git } from './git.ts';
import type { Push } from './report.ts';

/** The branch HEAD is on, when it tracks the branch of its own name on `origin`; otherwise `undefined`. */
async function trackedOnOrigin(folder: string) {
	const branch = await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']);
	if (branch.code !== 0) return undefined;
	const name = branch.stdout.toString().trim();
	const remote = await git(folder, [
		'config',
		'--get',
		`branch.${name}.remote`,
	]);
	const merge = await git(folder, ['config', '--get', `branch.${name}.merge`]);
	if (
		remote.stdout.toString().trim() !== 'origin' ||
		merge.stdout.toString().trim() !== `refs/heads/${name}`
	)
		return undefined;
	return name;
}

/** Push the commit just made, fast-forward only; `null` when the branch does not track its own name on `origin`. */
export async function pushToOrigin(folder: string): Promise<Push | null> {
	const branch = await trackedOnOrigin(folder);
	if (!branch) return null;
	const ref = `refs/heads/${branch}`;
	const push = await git(folder, ['push', '-q', 'origin', `${ref}:${ref}`]);
	const counted = async () =>
		(await originOf(folder)) ?? { ahead: 0, behind: 0 };
	if (push.code === 0) return { pushed: true, ...(await counted()) };
	if (/\[rejected\]|non-fast-forward|fetch first/.test(push.stderr)) {
		// Fetching is not pulling: it only updates what this copy knows of origin, so the report and the listing can say it is behind.
		await git(folder, ['fetch', '-q', 'origin']);
		return {
			pushed: false,
			...(await counted()),
			reason: 'origin has commits this copy does not; the commit stays here',
			next: `git -C ${folder} pull --rebase`,
		};
	}
	return {
		pushed: false,
		...(await counted()),
		reason:
			push.stderr.split('\n')[0] || 'the push failed; the commit stays here',
		next: `git -C ${folder} push`,
	};
}

/** How far this copy is ahead of and behind what it knows of `origin`, or `undefined` when it does not track its own name there. */
export async function originOf(folder: string) {
	if (!(await trackedOnOrigin(folder))) return undefined;
	const counted = await git(folder, [
		'rev-list',
		'--left-right',
		'--count',
		'HEAD...@{u}',
	]);
	if (counted.code !== 0) return undefined;
	const [ahead = 0, behind = 0] = counted.stdout
		.toString()
		.trim()
		.split(/\s+/)
		.map(Number);
	return { ahead, behind };
}
