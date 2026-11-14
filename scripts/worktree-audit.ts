// Worktree and branch audit: which local copies are safe to delete.
//
// A local branch is disposable once its work is reachable from GitHub. This
// script states, for every local branch and every worktree, whether that is
// true and how it knows. It is read-only unless asked otherwise:
//
//   bun run worktrees                     list, after `git fetch --prune`
//   bun run worktrees --backup <branch…>  push each to origin as backup/<branch>
//   bun run worktrees --reap <branch…>    remove each branch and its worktree
//   --no-fetch                            skip the fetch (offline, tests)
//
// `--backup` only adds refs, so it needs no gate. `--reap` is destructive: run
// it only on names the owner approved from the listing. It re-checks every
// branch at the moment of deletion and refuses anything that is not covered,
// any worktree with uncommitted or untracked files, the default branch, and the
// worktree it runs in. It never passes `--force`, never moves `main`, and never
// deletes a remote ref; those stay manual.
//
// "Covered" means one of:
//   on-main    the tip is contained in origin/main, or every commit's patch is
//              (a rebase merge). A squash of several commits is not detected
//              this way, because `git cherry` compares one commit at a time.
//   merged     a merged PR's head is exactly this tip (catches squash merges).
//   backed-up  a ref under origin/backup/ contains the tip.
//   pr         a closed PR's head holds this tip; GitHub keeps
//              refs/pull/<n>/head after the branch is deleted. An open PR does
//              not count: a force-push can still drop the tip.
// A branch that is only pushed (origin/<name> equals the tip) is NOT covered:
// GitHub deletes PR branches on merge or close.
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const BASE = 'origin/main';
const DEFAULT_BRANCH = 'main';

function git(args: string[]): string {
	return execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function gitOk(args: string[]): boolean {
	return spawnSync('git', args, { stdio: 'ignore' }).status === 0;
}

function lines(text: string): string[] {
	return text.split('\n').filter(Boolean);
}

type Worktree = { path: string; branch: string | null; head: string };

function worktrees(): Worktree[] {
	const list: Worktree[] = [];
	let current: Partial<Worktree> = {};
	for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
		if (line.startsWith('worktree '))
			current = { path: line.slice(9), branch: null };
		else if (line.startsWith('HEAD ')) current.head = line.slice(5);
		else if (line.startsWith('branch '))
			current.branch = line.slice(7).replace('refs/heads/', '');
		else if (line === '' && current.path) {
			list.push(current as Worktree);
			current = {};
		}
	}
	if (current.path) list.push(current as Worktree);
	return list;
}

/** Changed or untracked files in a worktree; ignored files do not count. */
function dirtyCount(path: string): number {
	const r = spawnSync('git', ['-C', path, 'status', '--porcelain'], {
		encoding: 'utf8',
	});
	return r.status === 0 ? lines(r.stdout).length : Number.NaN;
}

type PullRequest = {
	number: number;
	state: string;
	headRefName: string;
	headRefOid: string;
};

/** Every PR. Best-effort: no `gh`, or a non-GitHub origin, gives none. */
function pullRequests(): PullRequest[] {
	const r = spawnSync(
		'gh',
		[
			'pr',
			'list',
			'--state',
			'all',
			'--limit',
			'5000',
			'--json',
			'number,state,headRefName,headRefOid',
		],
		{ encoding: 'utf8' },
	);
	return r.status === 0 ? (JSON.parse(r.stdout) as PullRequest[]) : [];
}

/**
 * The PR whose head holds this tip: the same commit, or a later head of the
 * same branch (a bot's formatting commit, a fixup pushed after review). A
 * merged PR is the stronger proof when several match.
 */
function pullRequestFor(
	name: string | null,
	tip: string,
	prs: PullRequest[],
): PullRequest | undefined {
	const holds = (pr: PullRequest) =>
		pr.headRefOid === tip ||
		(pr.headRefName === name &&
			gitOk(['cat-file', '-e', `${pr.headRefOid}^{commit}`]) &&
			gitOk(['merge-base', '--is-ancestor', tip, pr.headRefOid]));
	const matches = prs.filter(holds);
	return matches.find((pr) => pr.state === 'MERGED') ?? matches[0];
}

type Verdict = {
	state:
		| 'on-main'
		| 'merged'
		| 'backed-up'
		| 'pr'
		| 'open-pr'
		| 'pushed'
		| 'local-only';
	covered: boolean;
	proof: string;
};

function classify(
	name: string | null,
	tip: string,
	prs: PullRequest[],
): Verdict {
	if (gitOk(['merge-base', '--is-ancestor', tip, BASE]))
		return { state: 'on-main', covered: true, proof: `contained in ${BASE}` };
	const pr = pullRequestFor(name, tip, prs);
	if (pr?.state === 'MERGED')
		return {
			state: 'merged',
			covered: true,
			proof: `PR #${pr.number} merged with this commit in its head`,
		};
	const unmerged = lines(git(['cherry', BASE, tip])).filter((l) =>
		l.startsWith('+'),
	).length;
	if (unmerged === 0)
		return {
			state: 'on-main',
			covered: true,
			proof: `every commit's patch is in ${BASE}`,
		};
	const backup = lines(
		git([
			'for-each-ref',
			'--contains',
			tip,
			'--format=%(refname:short)',
			'refs/remotes/origin/backup',
		]),
	)[0];
	if (backup) return { state: 'backed-up', covered: true, proof: backup };
	// A closed PR's head is frozen; an open one moves on a force-push.
	if (pr && pr.state !== 'OPEN')
		return {
			state: 'pr',
			covered: true,
			proof: `PR #${pr.number} (closed) keeps refs/pull/${pr.number}/head`,
		};
	if (pr)
		return {
			state: 'open-pr',
			covered: false,
			proof: `PR #${pr.number} is open; a force-push could drop this tip`,
		};
	const age = git(['log', '-1', '--format=%cr', tip]);
	if (
		name &&
		gitOk(['rev-parse', '-q', '--verify', `refs/remotes/origin/${name}`]) &&
		git(['rev-parse', `refs/remotes/origin/${name}`]) === tip
	)
		return {
			state: 'pushed',
			covered: false,
			proof: `origin/${name}, which GitHub may delete; ${unmerged} ${unmerged === 1 ? 'commit' : 'commits'} off ${BASE}, ${age}`,
		};
	return {
		state: 'local-only',
		covered: false,
		proof: `${unmerged} ${unmerged === 1 ? 'commit' : 'commits'} off ${BASE}, ${age}`,
	};
}

type Row = {
	branch: string;
	tip: string;
	worktree: Worktree | undefined;
	dirty: number | null;
	verdict: Verdict | null;
	note: string;
};

function audit(): Row[] {
	const trees = worktrees();
	const prs = pullRequests();
	const rows: Row[] = [];
	const branches = lines(
		git([
			'for-each-ref',
			'--format=%(refname:short) %(objectname)',
			'refs/heads',
		]),
	);
	for (const entry of branches) {
		const [branch, tip] = entry.split(' ') as [string, string];
		const worktree = trees.find((t) => t.branch === branch);
		const dirty = worktree ? dirtyCount(worktree.path) : null;
		if (branch === DEFAULT_BRANCH) {
			const [behind, ahead] = git([
				'rev-list',
				'--left-right',
				'--count',
				`${BASE}...${tip}`,
			]).split(/\s+/);
			rows.push({
				branch,
				tip,
				worktree,
				dirty,
				verdict: null,
				note: `${behind} behind, ${ahead} ahead of ${BASE}`,
			});
			continue;
		}
		const verdict = classify(branch, tip, prs);
		rows.push({ branch, tip, worktree, dirty, verdict, note: verdict.proof });
	}
	for (const t of trees.filter((t) => t.branch === null)) {
		const verdict = classify(null, t.head, prs);
		rows.push({
			branch: `(detached ${t.head.slice(0, 10)})`,
			tip: t.head,
			worktree: t,
			dirty: dirtyCount(t.path),
			verdict,
			note: verdict.proof,
		});
	}
	return rows;
}

function home(path: string): string {
	const h = process.env.HOME;
	return h && path.startsWith(h) ? `~${path.slice(h.length)}` : path;
}

function print(rows: Row[]): void {
	const table = rows.map((r) => [
		r.verdict?.state ?? 'main',
		r.branch,
		r.worktree ? home(r.worktree.path) : '-',
		r.dirty === null ? '-' : String(r.dirty),
		r.note,
	]);
	const header = ['STATE', 'BRANCH', 'WORKTREE', 'DIRTY', 'PROOF'];
	const widths = header.map((h, i) =>
		Math.max(h.length, ...table.map((row) => (row[i] ?? '').length)),
	);
	for (const row of [header, ...table])
		console.log(
			row
				.map((cell, i) =>
					i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0),
				)
				.join('  '),
		);
	const reapable = rows.filter((r) => r.verdict?.covered && !r.dirty);
	const exposed = rows.filter((r) => r.verdict && !r.verdict.covered);
	console.log(
		`\n${reapable.length} covered and clean; ${exposed.length} not covered yet.`,
	);
}

function backup(names: string[]): number {
	const prs = pullRequests();
	let failures = 0;
	for (const name of names) {
		if (!gitOk(['rev-parse', '-q', '--verify', `refs/heads/${name}`])) {
			console.error(`skip ${name}: no such local branch`);
			failures++;
			continue;
		}
		const tip = git(['rev-parse', `refs/heads/${name}`]);
		const verdict = classify(name, tip, prs);
		if (verdict.covered) {
			console.log(`skip ${name}: already ${verdict.state} (${verdict.proof})`);
			continue;
		}
		let target = name.startsWith('backup/') ? name : `backup/${name}`;
		if (gitOk(['rev-parse', '-q', '--verify', `refs/remotes/origin/${target}`]))
			target = `${target}-${tip.slice(0, 7)}`;
		const pushed = spawnSync(
			'git',
			['push', '-q', 'origin', `${tip}:refs/heads/${target}`],
			{ stdio: 'inherit' },
		);
		const remote = lines(
			git(['ls-remote', 'origin', `refs/heads/${target}`]),
		)[0]?.split('\t')[0];
		if (pushed.status !== 0 || remote !== tip) {
			console.error(
				`FAILED ${name}: origin/${target} is ${remote ?? 'missing'}, expected ${tip}`,
			);
			failures++;
			continue;
		}
		git([
			'fetch',
			'-q',
			'origin',
			`refs/heads/${target}:refs/remotes/origin/${target}`,
		]);
		console.log(`backed up ${name} -> origin/${target} at ${tip.slice(0, 10)}`);
	}
	return failures;
}

function reap(names: string[]): number {
	const prs = pullRequests();
	const here = realpathSync(git(['rev-parse', '--show-toplevel']));
	const trees = worktrees();
	let refusals = 0;
	const refuse = (name: string, why: string) => {
		console.error(`refuse ${name}: ${why}`);
		refusals++;
	};
	for (const name of names) {
		if (name === DEFAULT_BRANCH) {
			refuse(name, 'the default branch is never reaped');
			continue;
		}
		if (!gitOk(['rev-parse', '-q', '--verify', `refs/heads/${name}`])) {
			refuse(name, 'no such local branch');
			continue;
		}
		const tip = git(['rev-parse', `refs/heads/${name}`]);
		const verdict = classify(name, tip, prs);
		if (!verdict.covered) {
			refuse(
				name,
				`not covered (${verdict.state}: ${verdict.proof}); back it up first`,
			);
			continue;
		}
		const tree = trees.find((t) => t.branch === name);
		if (tree) {
			if (realpathSync(tree.path) === here) {
				refuse(name, 'it is checked out in the worktree running this script');
				continue;
			}
			const dirty = dirtyCount(tree.path);
			if (dirty !== 0) {
				refuse(
					name,
					`${home(tree.path)} has ${dirty} uncommitted or untracked files; judge them by hand`,
				);
				continue;
			}
			const removed = spawnSync('git', ['worktree', 'remove', tree.path], {
				stdio: 'inherit',
			});
			if (removed.status !== 0) {
				refuse(name, `git worktree remove ${home(tree.path)} failed`);
				continue;
			}
		}
		// Delete only if the branch still points at the tip that was checked.
		if (!gitOk(['update-ref', '-d', `refs/heads/${name}`, tip])) {
			refuse(name, 'the branch moved during the reap; re-run the audit');
			continue;
		}
		console.log(
			`reaped ${name}${tree ? ` and ${home(tree.path)}` : ''} (${verdict.proof})`,
		);
	}
	return refusals;
}

const args = process.argv.slice(2);
const fetch = !args.includes('--no-fetch');
const mode = args.find((a) => a === '--backup' || a === '--reap');
const names = args.filter((a) => !a.startsWith('--'));

if (fetch) git(['fetch', '-q', '--prune', 'origin']);
if (!mode) {
	print(audit());
} else if (names.length === 0) {
	console.error(`${mode} needs explicit branch names; there is no "all".`);
	process.exit(2);
} else {
	process.exit((mode === '--backup' ? backup(names) : reap(names)) > 0 ? 1 : 0);
}
