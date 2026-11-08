/**
 * `origin` is an app's one remote, its meeting point and its backup
 * (ADR-0851). `epicenter` never pulls and never merges: after each commit it
 * makes, it pushes fast-forward only, and only when the branch tracks a branch
 * on `origin`. When the push cannot fast-forward, the commit stays local and
 * leaves with a later push; Git's unpushed commits are the only queue.
 */
import { git } from './git.ts';

/** What the push after a commit did, for the person reading stderr. */
export type Pushed =
	| { pushed: true }
	| { pushed: false; reason: string; next: string };

/** The branch HEAD is on and the branch it tracks on `origin`, or `undefined` when it tracks none there. */
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
	if (remote.stdout.toString().trim() !== 'origin' || merge.code !== 0)
		return undefined;
	return { branch: name, merge: merge.stdout.toString().trim() };
}

/** Push the commit just made, fast-forward only; `undefined` when the branch tracks nothing on `origin`. */
export async function pushToOrigin(
	folder: string,
): Promise<Pushed | undefined> {
	const tracked = await trackedOnOrigin(folder);
	if (!tracked) return undefined;
	const push = await git(folder, [
		'push',
		'-q',
		'origin',
		`HEAD:${tracked.merge}`,
	]);
	if (push.code === 0) return { pushed: true };
	if (/\[rejected\]|non-fast-forward|fetch first/.test(push.stderr)) {
		// Fetching is not pulling: it only updates what this copy knows of origin, so the listing can say it is behind.
		await git(folder, ['fetch', '-q', 'origin']);
		return {
			pushed: false,
			reason: 'origin has commits this copy does not; the commit stays here',
			next: `git -C ${folder} pull --rebase`,
		};
	}
	return {
		pushed: false,
		reason:
			push.stderr.split('\n')[0] || 'the push failed; the commit stays here',
		next: `git -C ${folder} push`,
	};
}

/** How far this copy is ahead of and behind what it knows of `origin`, or `undefined` when it tracks nothing there. */
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
