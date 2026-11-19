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
		write(dir, 'specs/old.md', 'See `packages/missing/src/index.ts`.\n');
		write(dir, '.agents/skill.md', 'See `packages/missing/src/index.ts`.\n');
		write(dir, '.claude/prompt.md', 'See `packages/missing/src/index.ts`.\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all paths resolve');
	});
});

test('relative link to a tracked file and heading passes', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/a.md',
			'[b](./b.md#some-heading) and [self](#top)\n\n# Top\n',
		);
		write(dir, 'docs/b.md', '# Some heading\n\n## Repeat\n\n## Repeat\n');
		write(dir, 'docs/c.md', '[dir](../docs/) [dup](b.md#repeat-1)\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('all links resolve');
	});
});

test('relative link to a missing file fails', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/a.md',
			'See [gone](./gone.md) and [abs](/Users/x/y.md).\n',
		);
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('docs/a.md:1  (./gone.md)  no such file');
		expect(out).toContain('(/Users/x/y.md)');
	});
});

test('link anchor with no matching heading fails', () => {
	withRepo((dir) => {
		write(dir, 'docs/a.md', '[x](b.md#nope) [y](#also-nope)\n');
		write(dir, 'docs/b.md', '# Real\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('(b.md#nope)  no heading for #nope');
		expect(out).toContain('(#also-nope)  no heading for #also-nope');
	});
});

test('links in code, external links, specs and history are not checked', () => {
	withRepo((dir) => {
		write(
			dir,
			'docs/a.md',
			'`[x](missing.md)` [web](https://example.com/a.md)\n\n```md\n[y](missing.md)\n```\n',
		);
		write(dir, 'specs/s.md', '[x](missing.md)\n');
		write(dir, 'docs/history.md', '[x](missing.md)\n');
		write(
			dir,
			'docs/ignored.md',
			'<!-- doc-path-check: ignore-file -->\n[x](missing.md)\n',
		);
		write(
			dir,
			'docs/line.md',
			'<!-- doc-path-check: ignore-next-line -->\n[x](missing.md)\n',
		);
		commitAll(dir);

		const { code } = run(dir);

		expect(code).toBe(0);
	});
});

test('skill docs are checked for dead links', () => {
	withRepo((dir) => {
		write(dir, '.agents/skills/s/SKILL.md', '[r](references/gone.md)\n');
		commitAll(dir);

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('.agents/skills/s/SKILL.md:1');
	});
});
