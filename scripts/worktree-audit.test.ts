/**
 * Worktree audit tests.
 *
 * Each test builds a throwaway clone with a local bare `origin`. The script
 * reads everything through `git` in its process cwd, so spawning it inside the
 * clone exercises the real code path.
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
	return execFileSync(
		'git',
		['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
		{ cwd, encoding: 'utf8', stdio: 'pipe' },
	).trim();
}

function commit(cwd: string, file: string): string {
	writeFileSync(path.join(cwd, file), file);
	git(cwd, 'add', file);
	git(cwd, 'commit', '-q', '-m', file);
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
	commit(repo, 'a.txt');
	git(repo, 'push', '-q', 'origin', 'main');
	return { root, repo };
}

function run(cwd: string, ...args: string[]) {
	const r = spawnSync('bun', [scriptPath, ...args], { cwd, encoding: 'utf8' });
	return { status: r.status, out: r.stdout + r.stderr };
}

function row(out: string, branch: string): string {
	return out.split('\n').find((l) => l.split(/\s+/)[1] === branch) ?? '';
}

test('lists merged and rebased branches as covered, others as uncovered', () => {
	const { repo } = fixture();

	git(repo, 'switch', '-q', '-c', 'merged');
	commit(repo, 'm.txt');
	git(repo, 'switch', '-q', 'main');
	git(repo, 'merge', '-q', '--ff-only', 'merged');

	git(repo, 'switch', '-q', '-c', 'rebased');
	commit(repo, 'r.txt');
	git(repo, 'switch', '-q', 'main');
	// Move main first, so the cherry-pick is a new commit, not the same hash.
	commit(repo, 'b.txt');
	git(repo, 'cherry-pick', 'rebased');
	git(repo, 'push', '-q', 'origin', 'main');

	// Pushed under its own name only: GitHub deletes that ref when a PR closes.
	git(repo, 'switch', '-q', '-c', 'pushed');
	commit(repo, 'p.txt');
	git(repo, 'push', '-q', 'origin', 'pushed');
	git(repo, 'switch', '-q', 'main');

	const { out } = run(repo);
	expect(row(out, 'merged')).toStartWith('covered');
	expect(row(out, 'rebased')).toContain("every commit's patch");
	expect(row(out, 'pushed')).toStartWith('UNCOVERED');
	expect(row(out, 'main')).toContain('0 behind, 0 ahead');
});

test('reap removes a covered clean worktree and its branch', () => {
	const { root, repo } = fixture();
	const tree = path.join(root, 'tree');
	git(repo, 'worktree', 'add', '-q', '-b', 'done', tree, 'main');

	const { status, out } = run(repo, 'reap', 'done');
	expect(status).toBe(0);
	expect(out).toContain('reaped done');
	expect(existsSync(tree)).toBe(false);
	expect(git(repo, 'branch', '--list', 'done')).toBe('');
});

test('reap backs up an uncovered branch before deleting it', () => {
	const { repo } = fixture();
	git(repo, 'switch', '-q', '-c', 'idea');
	const first = commit(repo, 'i.txt');
	git(repo, 'switch', '-q', 'main');

	expect(run(repo, 'reap', 'idea').out).toContain('origin/backup/idea');
	expect(git(repo, 'branch', '--list', 'idea')).toBe('');
	expect(git(repo, 'rev-parse', 'origin/backup/idea')).toBe(first);

	// A later branch of the same name does not overwrite the first backup.
	git(repo, 'switch', '-q', '-c', 'idea');
	const second = commit(repo, 'j.txt');
	git(repo, 'switch', '-q', 'main');
	run(repo, 'reap', 'idea');
	expect(git(repo, 'rev-parse', 'origin/backup/idea')).toBe(first);
	expect(
		git(repo, 'rev-parse', `origin/backup/idea-${second.slice(0, 7)}`),
	).toBe(second);
});

test('reap refuses a dirty worktree and the default branch', () => {
	const { root, repo } = fixture();
	const tree = path.join(root, 'tree');
	git(repo, 'worktree', 'add', '-q', '-b', 'dirty', tree, 'main');
	writeFileSync(path.join(tree, 'scratch.txt'), 'x');

	const { status, out } = run(repo, 'reap', 'dirty', 'main', 'missing');
	expect(status).toBe(1);
	expect(out).toContain('refuse dirty:');
	expect(out).toContain('refuse main: the default branch is never reaped');
	expect(out).toContain('refuse missing: no such local branch');
	expect(existsSync(tree)).toBe(true);
});

test('reap needs explicit names', () => {
	const { repo } = fixture();
	expect(run(repo, 'reap').status).toBe(2);
});
