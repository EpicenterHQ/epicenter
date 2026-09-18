/**
 * Vocabulary gate tests.
 *
 * Driven against throwaway git repos, like the doc-path gate, because the
 * contract is "tracked files, scoped by path". The scoping IS the rule here:
 * `scalar` is refused nearly everywhere and `prose` only where the store's
 * vocabulary lives, so most of what is worth pinning is which files each word
 * reaches.
 */

import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./check-vocabulary.ts', import.meta.url),
);

function git(cwd: string, args: string[]): void {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'vocabulary-'));
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

test('the settled words pass', () => {
	withRepo((dir) => {
		write(
			dir,
			'packages/data/src/row.ts',
			'// a field holds a value or a node\n',
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(0);
		expect(out).toContain('no retired words');
	});
});

test('a retired word fails, with its file, line, and replacement', () => {
	withRepo((dir) => {
		write(dir, 'packages/data/src/row.ts', '// ok\n// a scalar field\n');
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('packages/data/src/row.ts:2');
		expect(out).toContain('use value');
	});
});

test('the plural and the capital both count', () => {
	withRepo((dir) => {
		write(dir, 'packages/data/a.ts', '// the scalars\n');
		write(dir, 'packages/data/b.ts', '// Scalar fields\n');
		commitAll(dir);
		expect(run(dir).code).toBe(1);
	});
});

test('an untracked file is not scanned, so the verdict does not depend on the machine', () => {
	withRepo((dir) => {
		write(dir, 'packages/data/src/row.ts', '// clean\n');
		commitAll(dir);
		write(dir, 'packages/data/src/stray.ts', '// a scalar\n');
		expect(run(dir).code).toBe(0);
	});
});

test('dated records keep their words', () => {
	withRepo((dir) => {
		write(dir, 'docs/adr/0299-a-row-is-its-scalars.md', 'Its scalars.\n');
		write(dir, 'specs/old.md', 'The scalar plan, and prose.\n');
		write(dir, 'docs/articles/why.md', 'Prose and scalars.\n');
		write(dir, 'README.md', 'clean\n');
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('Matter is its own universe and keeps its own words', () => {
	withRepo((dir) => {
		write(
			dir,
			'packages/matter-core/src/field.ts',
			'// the closed scalar metas\n',
		);
		write(dir, 'apps/matter/src/grid.svelte', '<!-- a scalar cell -->\n');
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('an app with its own SQLite mirror may lift scalar columns', () => {
	withRepo((dir) => {
		write(
			dir,
			'apps/local-books/src/entities.ts',
			'// extracted scalar columns\n',
		);
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('prose is refused inside the store and allowed outside it', () => {
	withRepo((dir) => {
		write(dir, 'packages/data/src/row.ts', "// the row's prose\n");
		commitAll(dir);
		expect(run(dir).code).toBe(1);
	});
	withRepo((dir) => {
		// An ordinary English use, in a place the store's vocabulary does not reach.
		write(dir, '.agents/skills/writing-voice/SKILL.md', 'Revise the prose.\n');
		write(
			dir,
			'packages/ui/src/markdown.svelte',
			'<div class="prose"></div>\n',
		);
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('column is not checked, because real columns exist', () => {
	withRepo((dir) => {
		write(
			dir,
			'packages/data/src/log.ts',
			'// the one column you have to understand\n',
		);
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('ProseMirror is a product name, not the word', () => {
	withRepo((dir) => {
		write(dir, 'packages/data/src/codec.ts', '// a ProseMirror node\n');
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('a marked line is allowed, and only that line', () => {
	withRepo((dir) => {
		write(
			dir,
			'packages/data/src/row.ts',
			"// vocab-check: ignore-next-line (YAML's word)\n// a YAML scalar\n// a scalar field\n",
		);
		commitAll(dir);
		const { code, out } = run(dir);
		expect(code).toBe(1);
		expect(out).toContain('packages/data/src/row.ts:3');
		expect(out).not.toContain('packages/data/src/row.ts:2');
	});
});

test('a whole file can opt out', () => {
	withRepo((dir) => {
		write(
			dir,
			'packages/data/src/legacy.md',
			'<!-- vocab-check: ignore-file -->\n\nScalars and prose, throughout.\n',
		);
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});

test('generated declarations and changelogs are skipped', () => {
	withRepo((dir) => {
		write(dir, 'apps/api/worker-configuration.d.ts', '// prose explanation\n');
		write(dir, 'packages/data/CHANGELOG.md', '- scalars removed\n');
		commitAll(dir);
		expect(run(dir).code).toBe(0);
	});
});
