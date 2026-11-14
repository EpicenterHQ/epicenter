/**
 * Worktree audit tests.
 *
 * Each test builds a throwaway clone with a local bare `origin`, so `gh` finds
 * no GitHub remote and PR coverage is absent. The script reads everything
 * through `git` in its process cwd, so spawning it inside the clone exercises
 * the real code path.
 */

import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./worktree-audit.ts', import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: 'pipe',
	}).trim();
}

function commit(cwd: string, file: string, body: string): string {
	writeFileSync(path.join(cwd, file), body);
	git(cwd, 'add', file);
	git(
		cwd,
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t',
		'commit',
		'-q',
		'-m',
		file,
	);
	return git(cwd, 'rev-parse', 'HEAD');
}

/** A clone of a bare origin, with `main` pushed. */
function fixture(): { root: string; repo: string } {
	const root = mkdtempSync(path.join(os.tmpdir(), 'worktree-audit-'));
	roots.push(root);
	const origin = path.join(root, 'origin.git');
	const repo = path.join(root, 'repo');
	git(root, 'init', '-q', '--bare', '-b', 'main', origin);
	git(root, 'clone', '-q', origin, repo);
	commit(repo, 'a.txt', 'a');
	git(repo, 'push', '-q', 'origin', 'main');
	return { root, repo };
}

function run(cwd: string, ...args: string[]) {
	const r = spawnSync('bun', [scriptPath, '--no-fetch', ...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' },
	});
	return { status: r.status, out: r.stdout + r.stderr };
}

function row(out: string, branch: string): string {
	return out.split('\n').find((l) => l.split(/\s+/)[1] === branch) ?? '';
}

test('classifies merged, rebased, pushed, and local-only branches', () => {
	const { repo } = fixture();

	git(repo, 'switch', '-q', '-c', 'merged');
	commit(repo, 'm.txt', 'm');
	git(repo, 'switch', '-q', 'main');
	git(repo, 'merge', '-q', '--ff-only', 'merged');

	git(repo, 'switch', '-q', '-c', 'rebased');
	commit(repo, 'r.txt', 'r');
	git(repo, 'switch', '-q', 'main');
	// Move main first, so the cherry-pick is a new commit, not the same hash.
	commit(repo, 'b.txt', 'b');
	git(
		repo,
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t',
		'cherry-pick',
		'rebased',
	);
	git(repo, 'push', '-q', 'origin', 'main');

	git(repo, 'switch', '-q', '-c', 'pushed');
	commit(repo, 'p.txt', 'p');
	git(repo, 'push', '-q', 'origin', 'pushed');

	git(repo, 'switch', '-q', '-c', 'local', 'main');
	commit(repo, 'l.txt', 'l');
	git(repo, 'switch', '-q', 'main');
	git(repo, 'fetch', '-q', 'origin');

	const { out } = run(repo);
	expect(row(out, 'merged')).toStartWith('on-main');
	expect(row(out, 'rebased')).toStartWith('on-main');
	expect(row(out, 'rebased')).toContain("every commit's patch");
	expect(row(out, 'pushed')).toStartWith('pushed');
	expect(row(out, 'local')).toStartWith('local-only');
	expect(row(out, 'main')).toContain('0 behind, 0 ahead');
});

test('--backup pushes backup/<branch>, after which the branch is covered', () => {
	const { repo } = fixture();
	git(repo, 'switch', '-q', '-c', 'idea');
	const tip = commit(repo, 'i.txt', 'i');
	git(repo, 'switch', '-q', 'main');

	expect(run(repo, '--backup', 'idea').status).toBe(0);
	expect(
		git(repo, 'ls-remote', 'origin', 'refs/heads/backup/idea').split('\t')[0],
	).toBe(tip);
	expect(row(run(repo).out, 'idea')).toStartWith('backed-up');
	expect(run(repo, '--backup', 'idea').out).toContain(
		'skip idea: already backed-up',
	);
});

test('--reap removes a covered clean worktree and its branch', () => {
	const { root, repo } = fixture();
	const tree = path.join(root, 'tree');
	git(repo, 'worktree', 'add', '-q', '-b', 'done', tree, 'main');

	const { status, out } = run(repo, '--reap', 'done');
	expect(status).toBe(0);
	expect(out).toContain('reaped done');
	expect(existsSync(tree)).toBe(false);
	expect(git(repo, 'branch', '--list', 'done')).toBe('');
});

test('--reap refuses uncovered, dirty, and default branches', () => {
	const { root, repo } = fixture();
	git(repo, 'switch', '-q', '-c', 'local');
	commit(repo, 'l.txt', 'l');
	git(repo, 'switch', '-q', 'main');
	const tree = path.join(root, 'tree');
	git(repo, 'worktree', 'add', '-q', '-b', 'dirty', tree, 'main');
	writeFileSync(path.join(tree, 'scratch.txt'), 'x');

	const { status, out } = run(repo, '--reap', 'local', 'dirty', 'main');
	expect(status).toBe(1);
	expect(out).toContain('refuse local: not covered');
	expect(out).toContain('refuse dirty:');
	expect(out).toContain('refuse main: the default branch is never reaped');
	expect(existsSync(tree)).toBe(true);
	expect(git(repo, 'branch', '--list', 'local')).not.toBe('');
});

test('--reap and --backup need explicit names', () => {
	const { repo } = fixture();
	expect(run(repo, '--reap').status).toBe(2);
	expect(run(repo, '--backup').status).toBe(2);
});
