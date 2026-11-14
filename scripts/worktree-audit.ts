// Which local branches and worktrees are safe to delete, and deleting them.
//
//   bun run worktrees                 list every local branch and worktree
//   bun run worktrees reap <branch…>  delete the named branches and worktrees
//
// A local copy is disposable once its work is on GitHub. A branch is covered
// when its tip is contained in origin/main, when every commit's patch is on
// origin/main (it was rebased before landing), or when a ref under
// origin/backup/ contains it. This repository merges PRs with merge commits
// only, so a merged PR is always the first case.
//
// `reap` makes each named branch covered before deleting it: an uncovered tip
// is first pushed to origin as backup/<branch>. So reap cannot lose committed
// work. It refuses what it cannot keep or should not touch: a worktree with
// changed or untracked files, the default branch, and the worktree it runs in.
// It never passes --force, never moves main, and never deletes a remote ref.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const BASE = 'origin/main';
const DEFAULT_BRANCH = 'main';

function git(...args: string[]): string {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function gitOk(...args: string[]): boolean {
	return spawnSync('git', args, { stdio: 'ignore' }).status === 0;
}

function lines(text: string): string[] {
	return text.split('\n').filter(Boolean);
}

type Worktree = { path: string; branch: string | null; head: string };

function worktrees(): Worktree[] {
	return git('worktree', 'list', '--porcelain')
		.split('\n\n')
		.map((block) => {
			const field = (key: string) =>
				lines(block)
					.find((l) => l.startsWith(`${key} `))
					?.slice(key.length + 1);
			return {
				path: field('worktree') ?? '',
				head: field('HEAD') ?? '',
				branch: field('branch')?.replace('refs/heads/', '') ?? null,
			};
		});
}

/** Changed or untracked files in a worktree. Ignored files do not count. */
function dirtyCount(path: string): number {
	return lines(git('-C', path, 'status', '--porcelain')).length;
}

/** Why a tip is covered, or null when its work is only on this computer. */
function coverage(tip: string): string | null {
	if (gitOk('merge-base', '--is-ancestor', tip, BASE))
		return `contained in ${BASE}`;
	if (!git('cherry', BASE, tip).includes('+'))
		return `every commit's patch is in ${BASE}`;
	const backup = lines(
		git(
			'for-each-ref',
			'--contains',
			tip,
			'--format=%(refname:short)',
			'refs/remotes/origin/backup',
		),
	)[0];
	return backup ?? null;
}

function home(path: string): string {
	const h = process.env.HOME;
	return h && path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

function list(): void {
	const trees = worktrees();
	const row = (branch: string, tip: string, tree: Worktree | undefined) => {
		const covered = coverage(tip);
		const [behind, ahead] = git(
			'rev-list',
			'--left-right',
			'--count',
			`${BASE}...${tip}`,
		).split(/\s+/);
		return [
			branch === DEFAULT_BRANCH ? 'main' : covered ? 'covered' : 'UNCOVERED',
			branch,
			tree ? home(tree.path) : '-',
			tree ? String(dirtyCount(tree.path)) : '-',
			branch === DEFAULT_BRANCH
				? `${behind} behind, ${ahead} ahead of ${BASE}`
				: (covered ??
					`${ahead} ahead of ${BASE}, last commit ${git('log', '-1', '--format=%cr', tip)}`),
		];
	};
	const rows = [
		['STATE', 'BRANCH', 'WORKTREE', 'DIRTY', 'WHY'],
		...lines(
			git(
				'for-each-ref',
				'--format=%(refname:short) %(objectname)',
				'refs/heads',
			),
		).map((entry) => {
			const [branch = '', tip = ''] = entry.split(' ');
			return row(
				branch,
				tip,
				trees.find((t) => t.branch === branch),
			);
		}),
		...trees
			.filter((t) => t.branch === null)
			.map((t) => row(`(detached ${t.head.slice(0, 10)})`, t.head, t)),
	];
	const widths = rows[0]?.map((_, i) =>
		Math.max(...rows.map((r) => (r[i] ?? '').length)),
	);
	for (const r of rows)
		console.log(
			r
				.map((cell, i) => cell.padEnd(widths?.[i] ?? 0))
				.join('  ')
				.trimEnd(),
		);
}

/** Push an uncovered tip to origin as backup/<branch>. Returns the ref name. */
function backUp(branch: string, tip: string): string | null {
	let target = branch.startsWith('backup/') ? branch : `backup/${branch}`;
	// An earlier backup of this branch at another commit keeps its name.
	if (gitOk('rev-parse', '-q', '--verify', `refs/remotes/origin/${target}`))
		target = `${target}-${tip.slice(0, 7)}`;
	return gitOk('push', '-q', 'origin', `${tip}:refs/heads/${target}`)
		? `origin/${target}`
		: null;
}

function reap(branches: string[]): number {
	const here = realpathSync(git('rev-parse', '--show-toplevel'));
	const trees = worktrees();
	let refused = 0;
	for (const branch of branches) {
		const refuse = (why: string) => {
			console.error(`refuse ${branch}: ${why}`);
			refused++;
		};
		if (branch === DEFAULT_BRANCH) {
			refuse('the default branch is never reaped');
			continue;
		}
		if (!gitOk('rev-parse', '-q', '--verify', `refs/heads/${branch}`)) {
			refuse('no such local branch');
			continue;
		}
		const tip = git('rev-parse', `refs/heads/${branch}`);
		const tree = trees.find((t) => t.branch === branch);
		if (tree && realpathSync(tree.path) === here) {
			refuse('it is checked out in the worktree running this script');
			continue;
		}
		const dirty = tree ? dirtyCount(tree.path) : 0;
		if (tree && dirty > 0) {
			refuse(`${home(tree.path)} has ${dirty} changed or untracked files`);
			continue;
		}
		const covered = coverage(tip) ?? backUp(branch, tip);
		if (!covered) {
			refuse('it is not on GitHub and the backup push failed');
			continue;
		}
		if (tree && !gitOk('worktree', 'remove', tree.path)) {
			refuse(`git worktree remove ${home(tree.path)} failed`);
			continue;
		}
		// Delete only if the branch still points at the commit that was checked.
		if (!gitOk('update-ref', '-d', `refs/heads/${branch}`, tip)) {
			refuse('the branch moved during the reap; run the listing again');
			continue;
		}
		console.log(`reaped ${branch}: ${covered}`);
	}
	return refused;
}

const [command, ...branches] = process.argv.slice(2);
git('fetch', '-q', '--prune', 'origin');
if (command === undefined) {
	list();
} else if (command === 'reap' && branches.length > 0) {
	process.exit(reap(branches) > 0 ? 1 : 0);
} else {
	console.error('usage: bun run worktrees [reap <branch…>]');
	process.exit(2);
}
