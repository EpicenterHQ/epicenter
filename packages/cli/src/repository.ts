/**
 * What Git says about the home, for the bare `epicenter` report. Git stores
 * the home and `epicenter` does not wrap it: this only reads. It never
 * fetches, so the count against origin is as fresh as the last push or fetch.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { checkedGit, git, isRepositoryTop, originOf } from './git.ts';
import { APPS } from './root.ts';

export type RepositoryStatus = {
	/** When the last commit was made, or `null` before the first one. */
	lastCommit: string | null;
	/** How many files differ from that commit, untracked ones included. */
	uncommitted: number;
	/** `null` without an `origin` remote; `ahead` is absent until the branch is on origin. */
	origin: { branch: string; ahead?: number } | null;
	/** Folders under `apps/` that hold a `.git` of their own, as paths from the home. */
	nested: string[];
};

/** Folders under `prefix` holding a `.git`. Links are not followed, and a found repository is not searched. */
async function nestedRepositories(
	root: string,
	prefix: string,
): Promise<string[]> {
	const entries = await readdir(join(root, prefix), {
		withFileTypes: true,
	}).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});
	if (entries.some((entry) => entry.name === '.git')) return [prefix];
	const found: string[] = [];
	for (const entry of entries)
		if (entry.isDirectory() && entry.name !== 'node_modules')
			found.push(
				...(await nestedRepositories(root, `${prefix}/${entry.name}`)),
			);
	return found.sort();
}

/** The home's repository as it is now, or `null` when the home is not the top of one. */
export async function repositoryStatus(
	root: string,
): Promise<RepositoryStatus | null> {
	if (!(await isRepositoryTop(root))) return null;
	const [last, pending, origin, nested] = await Promise.all([
		git(root, ['log', '-1', '--format=%cI']),
		// -z and --no-renames: every record holds exactly one path.
		checkedGit(root, [
			'status',
			'--porcelain',
			'-z',
			'--untracked-files=all',
			'--no-renames',
		]),
		originOf(root),
		nestedRepositories(root, APPS),
	]);
	return {
		lastCommit:
			last.code === 0 && last.stdout
				? new Date(last.stdout).toISOString()
				: null,
		uncommitted: pending.split('\0').filter(Boolean).length,
		origin,
		nested,
	};
}

function count(n: number, one: string) {
	return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function ago(then: string, now: Date) {
	const minutes = Math.floor((now.getTime() - Date.parse(then)) / 60_000);
	if (minutes < 1) return 'less than a minute ago';
	if (minutes < 60) return `${count(minutes, 'minute')} ago`;
	if (minutes < 60 * 24)
		return `${count(Math.floor(minutes / 60), 'hour')} ago`;
	return `${count(Math.floor(minutes / (60 * 24)), 'day')} ago`;
}

/** The one line the bare `epicenter` report ends with. */
export function repositoryLine(
	root: string,
	status: RepositoryStatus | null,
	now = new Date(),
) {
	if (!status) return `${root} is not a Git repository; run: git init`;
	const { origin } = status;
	return [
		status.lastCommit
			? `last commit ${ago(status.lastCommit, now)}`
			: 'no commits yet',
		`${count(status.uncommitted, 'file')} uncommitted`,
		!origin
			? 'no origin'
			: origin.ahead !== undefined
				? `${count(origin.ahead, 'commit')} not on origin`
				: origin.branch
					? `${origin.branch} is not on origin yet`
					: 'not on a branch',
		...status.nested.map(
			(path) =>
				`${path} is a nested Git repository: backups hold only a pointer`,
		),
	].join('; ');
}
