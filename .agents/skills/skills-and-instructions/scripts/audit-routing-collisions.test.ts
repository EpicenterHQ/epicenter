/**
 * Routing collision contract tests.
 *
 * `references/composition-audit.md` documents this script's exit codes and its
 * `phrase -> skill/SKILL.md` line format, so both are contract rather than
 * implementation. These tests exist so the shared-catalog extraction and the
 * `--explain` flag cannot drift them.
 *
 * The content-coupled assertions are deliberate. "asymmetric wins" having
 * exactly one owner, and "simplify this" being owned by collapse-pass while
 * control-flow routes it there, are routing facts the composition audit is
 * built around; if a description edit changes one, a failing test here is the
 * report, not noise.
 *
 * There is no test for two skills claiming one phrase, because no phrase in
 * the library does and a fixture invented to prove it would only assert
 * itself. That branch is covered where skills can be injected: see
 * `runLexicalPass > reports several claimants as ambiguous`.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(
	new URL('./audit-routing-collisions.ts', import.meta.url),
);

function run(...args: string[]): {
	code: number | null;
	out: string;
	err: string;
} {
	const result = spawnSync('bun', [scriptPath, ...args], { encoding: 'utf8' });
	return { code: result.status, out: result.stdout, err: result.stderr };
}

test('no phrase is a usage error', () => {
	const { code, err } = run();

	expect(code).toBe(2);
	expect(err).toContain('Usage:');
});

test('--help prints usage and succeeds', () => {
	const { code, out } = run('--help');

	expect(code).toBe(0);
	expect(out).toContain('--explain');
});

test('a phrase no description mentions exits 1 with no owner', () => {
	const { code, out, err } = run('zzz-no-skill-claims-this');

	expect(code).toBe(1);
	expect(out).toBe('');
	expect(err).toContain('No skill description claims');
});

test('a single owner exits 0 in the documented line format', () => {
	const { code, out } = run('asymmetric wins');

	expect(code).toBe(0);
	expect(out).toBe('asymmetric wins -> asymmetric-wins/SKILL.md\n');
});

test('--explain annotates without changing the line prefix or exit code', () => {
	const plain = run('asymmetric wins');
	const explained = run('--explain', 'asymmetric wins');

	expect(explained.code).toBe(plain.code);
	expect(explained.out).toBe(
		'asymmetric wins -> asymmetric-wins/SKILL.md [claims]\n',
	);
});

test('one claimant beside a disclaiming mention is clean routing', () => {
	// The shape every resolved boundary has: an owner, plus the neighbour that
	// routes the phrase to it. Counting mentions would call this a collision.
	const { code, out } = run('--explain', 'simplify this');

	expect(code).toBe(0);
	expect(out).toContain('collapse-pass/SKILL.md [claims]');
	expect(out).toContain('control-flow/SKILL.md [disclaims]');
});

test('a phrase every mention routes away is reported as unowned', () => {
	// one-sentence-test sends this back to the agent and nobody accepts it,
	// which is the intended routing. The script reports unowned; whether unowned
	// is correct stays the reader's call.
	const { code, out, err } = run(
		'--explain',
		'plain code-comprehension question',
	);

	expect(code).toBe(1);
	expect(out).toContain('one-sentence-test/SKILL.md [disclaims]');
	expect(err).toContain('No skill description claims');
	expect(err).toContain('route it elsewhere');
});

test('an always-on claimant is reported without changing stdout or the exit code', () => {
	// `AGENTS.md` routes "clean break" to post-implementation-review while
	// greenfield-clean-breaks claims the phrase in its description, so the
	// documented verdict says clean routing while two surfaces actually claim
	// it. Reporting that on stderr is the whole point; changing the exit code
	// would break the contract composition-audit.md documents.
	const { code, out, err } = run('clean break');

	expect(code).toBe(0);
	expect(out).toBe('clean break -> greenfield-clean-breaks/SKILL.md\n');
	expect(err).toContain('AGENTS.md');
	expect(err).toContain('loads before any description');
});

test('a phrase no always-on file mentions reports no always-on claimant', () => {
	const { err } = run('asymmetric wins');

	expect(err).not.toContain('AGENTS.md');
});
