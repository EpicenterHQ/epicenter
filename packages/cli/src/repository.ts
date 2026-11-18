/**
 * What Git says about the home, for the bare `epicenter` report. Git stores
 * the home and `epicenter` does not wrap it: this only reads. It never
 * fetches, so the count against origin is as fresh as the last push or fetch.
 */
import { checkedGit, git, isRepositoryTop, originOf } from './git.ts';

export type RepositoryStatus = {
	/** When the last commit was made, or `null` before the first one. */
	lastCommit: string | null;
	/** How many files differ from that commit, untracked ones included. */
	uncommitted: number;
	/** `null` without an `origin` remote; `ahead` is absent until the branch is on origin. */
	origin: { branch: string; ahead?: number } | null;
	/**
	 * Repositories inside the home that its history holds only as a pointer,
	 * as paths from the home: one Git lists as untracked (`dir/`) or one
	 * already recorded as a gitlink. Ignored folders are not looked at.
	 */
	nested: string[];
};

/** The home's repository as it is now, or `null` when the home is not the top of one. */
export async function repositoryStatus(
	root: string,
): Promise<RepositoryStatus | null> {
	if (!(await isRepositoryTop(root))) return null;
	const [last, pending, origin, index] = await Promise.all([
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
		checkedGit(root, ['ls-files', '--stage', '-z']),
	]);
	const records = pending.split('\0').filter(Boolean);
	// With every untracked file listed, an untracked folder is a repository.
	const untracked = records
		.filter((record) => record.startsWith('?? ') && record.endsWith('/'))
		.map((record) => record.slice(3, -1));
	// `<mode> <object> <stage>\t<path>`; mode 160000 is a gitlink.
	const linked = index
		.split('\0')
		.filter((entry) => entry.startsWith('160000 '))
		.map((entry) => entry.slice(entry.indexOf('\t') + 1));
	return {
		lastCommit:
			last.code === 0 && last.stdout
				? new Date(last.stdout).toISOString()
				: null,
		uncommitted: records.length,
		origin,
		nested: [...new Set([...untracked, ...linked])].sort(),
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
