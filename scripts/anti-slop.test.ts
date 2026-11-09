/**
 * Exercise the installed Oxlint plugin through the repository configuration.
 * The selected rules must load, retain their error/warning severities, and
 * accept precise types and justified assertions without enabling other rules.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

function lint(source: string) {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-anti-slop-'));
	try {
		const file = join(directory, 'fixture.ts');
		writeFileSync(file, source);
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				join(root, 'node_modules/oxlint/bin/oxlint'),
				'--config',
				join(root, '.oxlintrc.json'),
				'--format=json',
				file,
			],
			cwd: root,
		});
		return {
			exitCode: result.exitCode,
			report: JSON.parse(result.stdout.toString()),
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test.each([
	{
		rule: 'no-chained-type-assertions',
		source: 'const account = input as unknown as Account;',
	},
	{
		rule: 'no-known-value-widening',
		source: 'const handlers: Record<string, () => void> = { save: () => {} };',
	},
	{
		rule: 'no-widen-then-assert',
		source:
			'const account = { id: 1 }; const wide: unknown = account; const restored = wide as { id: number };',
	},
])('$rule rejects its forbidden pattern', ({ rule, source }) => {
	const result = lint(source);
	expect(result.exitCode).toBe(1);
	expect(result.report).toMatchObject({
		number_of_rules: 4,
		diagnostics: expect.arrayContaining([
			expect.objectContaining({
				code: `anti-slop(${rule})`,
				severity: 'error',
			}),
		]),
	});
});

test('an unjustified assertion warns without failing the command', () => {
	const result = lint('const one = value as 1;');
	expect(result.exitCode).toBe(0);
	expect(result.report.diagnostics).toEqual([
		expect.objectContaining({
			code: 'anti-slop(require-safety-comment-for-type-assertion)',
			severity: 'warning',
		}),
	]);
});

test('precise types, satisfies, const assertions, and justified casts pass', () => {
	const result = lint(`
		const handlers = { save: () => {} } satisfies Record<string, () => void>;
		const account = { id: 1 } as const;
		const stored = account;
		// SAFETY: the numeric literal matches the asserted literal type.
		const one = 1 as 1;
	`);
	expect(result.exitCode).toBe(0);
	expect(result.report.diagnostics).toEqual([]);
});

test('unselected anti-slop and built-in rules stay disabled', () => {
	const result = lint(`
		type AccountShape = { id: string };
		function inspect(value: unknown): unknown {
			debugger;
			if (typeof value === 'string') return value;
			return value;
		}
	`);
	expect(result.exitCode).toBe(0);
	expect(result.report.diagnostics).toEqual([]);
});
