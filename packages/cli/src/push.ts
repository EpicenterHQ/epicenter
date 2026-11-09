/**
 * How far an app's branch is ahead of and behind the branch of its own name
 * on `origin`, for the listing (ADR-0851).
 */
import { git } from './git.ts';

/** The branch HEAD is on, when it tracks the branch of its own name on `origin`; otherwise `undefined`. */
async function trackedOnOrigin(folder: string) {
	const branch = await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']);
	if (branch.code !== 0) return undefined;
	const name = branch.stdout.trim();
	const remote = await git(folder, [
		'config',
		'--get',
		`branch.${name}.remote`,
	]);
	const merge = await git(folder, ['config', '--get', `branch.${name}.merge`]);
	if (
		remote.stdout.trim() !== 'origin' ||
		merge.stdout.trim() !== `refs/heads/${name}`
	)
		return undefined;
	return name;
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
	const [ahead = 0, behind = 0] = counted.stdout.split(/\s+/).map(Number);
	return { ahead, behind };
}
