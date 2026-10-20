/**
 * Skill link audit tests.
 *
 * These drive the script against throwaway skill trees rather than the real
 * one, so the gate's rules stay pinned even as skills are added and renamed.
 * The false-positive rules matter most: skills ship example posts and prompt
 * templates full of placeholder links, and a checker that flags those gets
 * turned off.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./audit-skill-links.ts', import.meta.url),
);

function write(dir: string, rel: string, body: string): void {
	const target = path.join(dir, rel);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, body);
}

function run(root: string): { code: number | null; out: string } {
	const result = spawnSync('bun', [scriptPath, '--root', root], {
		encoding: 'utf8',
	});
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function withTree(fn: (dir: string) => void): void {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-links-'));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('a reference link that resolves passes', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/SKILL.md',
			'Read [notes](references/notes.md) when stuck.\n',
		);
		write(dir, 'alpha/references/notes.md', '# Notes\n');

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('a reference link that resolves nowhere is reported', () => {
	withTree((dir) => {
		write(dir, 'alpha/SKILL.md', 'Read [gone](references/gone.md).\n');

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('DEAD_LINK');
		expect(out).toContain('alpha/SKILL.md:1');
		expect(out).toContain('references/gone.md');
	});
});

test('a cross-skill link resolves against the linking file, not the tree root', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/references/deep.md',
			'See [beta](../../beta/SKILL.md).\n',
		);
		write(dir, 'alpha/SKILL.md', '# Alpha\n');
		write(dir, 'beta/SKILL.md', '# Beta\n');

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('links inside fenced code blocks are not checked', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/SKILL.md',
			'Template:\n\n```md\nSee [docs](references/never-exists.md).\n```\n',
		);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('a placeholder target that names no file is not a link claim', () => {
	withTree((dir) => {
		write(dir, 'alpha/SKILL.md', 'See the [full implementation here](link).\n');

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('external and anchor-only targets are skipped', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/SKILL.md',
			'# Alpha\n\n## Setup\n\n[docs](https://example.com/x.md), [mail](mailto:a@b.co), [jump](#setup).\n',
		);

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('an anchor that matches a heading in the target passes', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/SKILL.md',
			'See [step](references/how.md#run-the-check).\n',
		);
		write(dir, 'alpha/references/how.md', '# How\n\n## Run The Check\n');

		const { code, out } = run(dir);

		expect(code).toBe(0);
		expect(out).toContain('no dead links or anchors');
	});
});

test('an anchor with no matching heading is reported separately from a dead link', () => {
	withTree((dir) => {
		write(
			dir,
			'alpha/SKILL.md',
			'See [step](references/how.md#renamed-section).\n',
		);
		write(dir, 'alpha/references/how.md', '# How\n\n## Run The Check\n');

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('DEAD_ANCHOR');
		expect(out).not.toContain('DEAD_LINK');
	});
});

test('a heading inside a fenced block does not satisfy an anchor', () => {
	withTree((dir) => {
		write(dir, 'alpha/SKILL.md', 'See [step](references/how.md#fake).\n');
		write(dir, 'alpha/references/how.md', '# How\n\n```md\n## Fake\n```\n');

		const { code, out } = run(dir);

		expect(code).toBe(1);
		expect(out).toContain('DEAD_ANCHOR');
	});
});

test('--json emits machine-readable findings', () => {
	withTree((dir) => {
		write(dir, 'alpha/SKILL.md', 'Read [gone](references/gone.md).\n');

		const result = spawnSync('bun', [scriptPath, '--root', dir, '--json'], {
			encoding: 'utf8',
		});
		const parsed = JSON.parse(result.stdout);

		expect(result.status).toBe(1);
		expect(parsed.findings).toHaveLength(1);
		expect(parsed.findings[0]).toMatchObject({
			kind: 'DEAD_LINK',
			file: 'alpha/SKILL.md',
			line: 1,
			target: 'references/gone.md',
		});
	});
});

test('the real skill tree has no dead links or anchors', () => {
	const skillsDir = fileURLToPath(new URL('../..', import.meta.url));
	const { code, out } = run(skillsDir);

	expect(out).not.toContain('DEAD_LINK');
	expect(out).not.toContain('DEAD_ANCHOR');
	expect(code).toBe(0);
});
