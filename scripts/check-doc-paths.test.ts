/**
 * Doc path gate tests.
 *
 * These drive the script against throwaway git repos because the gate's
 * contract is "tracked Markdown docs and tracked file references." Using git in
 * the fixture is the simplest way to keep that contract honest.
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./check-doc-paths.ts', import.meta.url),
);

function git(cwd: string, args: string[]): void {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'doc-paths-'));
	git(dir, ['init', '-q', '-b', 'main']);
	git(dir, ['config', 'user.email', 'fixture@test.local']);
	git(dir, ['config', 'user.name', 'Fixture']);
	git(dir, ['config', 'commit.gpgsign', 'false']);
	return dir;
}

function write(dir: string, rel: string, body: string): void {
	const target = path.join(dir, rel);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, body);
}

function commitAll(dir: string): void {
	git(dir, ['add', '-A']);
	git(dir, ['commit', '-q', '-m', 'fixture']);
}

function run(dir: string): { code: number | null; out: string } {
	const r = spawnSync('bun', [scriptPath], { cwd: dir, encoding: 'utf8' });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function withRepo(fn: (dir: string) => void): void {
	const dir = makeRepo();
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('living doc passes when backticked repo path exists', () => {
	withRepo((dir) => {
		write(dir, 'README.md', 'See `scripts/check-doc-paths.ts`.\n');
		write(dir, 'scripts/check-doc-paths.ts', 'export {};\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('any filename extension is treated as a file claim', () => {
	withRepo((dir) => {
		write(dir, 'README.md', 'See `packages/ui/src/prose.css`.\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('README.md:1  packages/ui/src/prose.css');
	});
});

test('non-repo-rooted tokens are not treated as file claims', () => {
	withRepo((dir) => {
		write(
			dir,
			'README.md',
			'Examples: `src/lib.ts`, `node_modules/lib/index.ts`, `@epicenter/ui`.\n',
		);
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('untracked files are treated as dead references', () => {
	withRepo((dir) => {
		write(dir, 'README.md', 'See `scripts/generated.ts`.\n');
		write(dir, 'scripts/generated.ts', 'export {};\n');
		git(dir, ['add', 'README.md']);
		git(dir, ['commit', '-q', '-m', 'fixture']);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('README.md:1  scripts/generated.ts');
	});
});

test('line suffixes are ignored when resolving a path', () => {
	withRepo((dir) => {
		write(
			dir,
			'README.md',
			'See `scripts/check-doc-paths.ts:42`, ' +
				'`scripts/check-doc-paths.ts:42:7`, and ' +
				'`scripts/check-doc-paths.ts:42-50`.\n',
		);
		write(dir, 'scripts/check-doc-paths.ts', 'export {};\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('living doc fails when backticked repo path is dead', () => {
	withRepo((dir) => {
		write(dir, 'README.md', 'See `packages/missing/src/index.ts`.\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('dead file reference');
		expect(out).toContain('README.md:1  packages/missing/src/index.ts');
	});
});

test('ignore-next-line skips one intentionally stale path', () => {
	withRepo((dir) => {
		write(
			dir,
			'README.md',
			'<!-- doc-path-check: ignore-next-line (historical) -->\n' +
				'See `packages/missing/src/index.ts`.\n',
		);
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('ignore-file skips a historical doc', () => {
	withRepo((dir) => {
		write(
			dir,
			'README.md',
			'<!-- doc-path-check: ignore-file (historical) -->\n' +
				'See `packages/missing/src/index.ts`.\n',
		);
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('specs and pattern paths are not treated as live file claims', () => {
	withRepo((dir) => {
		write(dir, 'README.md', 'Pattern: `apps/.../src/index.ts`.\n');
		write(
			dir,
			'specs/20260101T000000-old.md',
			'`packages/missing/src/index.ts`\n',
		);
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('untracked markdown is not part of the scan', () => {
	withRepo((dir) => {
		write(dir, 'README.md', '# Clean\n');
		commitAll(dir);
		write(dir, 'draft.md', 'See `packages/missing/src/index.ts`.\n');

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('excluded docs are not scanned', () => {
	withRepo((dir) => {
		write(dir, 'README.md', '# Clean\n');
		write(
			dir,
			'docs/articles/old.md',
			'See `packages/missing/src/index.ts`.\n',
		);
		write(dir, '.agents/skill.md', 'See `packages/missing/src/index.ts`.\n');
		write(dir, '.claude/prompt.md', 'See `packages/missing/src/index.ts`.\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});
