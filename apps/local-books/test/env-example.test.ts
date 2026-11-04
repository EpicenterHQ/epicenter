/**
 * Drift guard for `.env.example` (ADR-0108): the committed file must document
 * exactly the environment-qualified names `QB_SPEC` resolves, no more and no
 * fewer. `specToEnvExampleLines` builds those names from the same name-builder
 * the resolver reads through, so this test fails the moment the file lists a
 * stale name (e.g. the retired unqualified `QB_CLIENT_ID`) or omits a real one.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { specToEnvExampleLines } from '../src/provider-credentials.ts';
import { QB_SPEC } from '../src/qb-credentials.ts';

/** Extract the `NAME=` variable names from `.env.example`-style lines. */
function envNames(lines: string[]): string[] {
	return lines
		.filter((line) => /^[A-Z0-9_]+=/.test(line))
		.map((line) => line.slice(0, line.indexOf('=')));
}

test(".env.example lists exactly QB_SPEC's qualified names", () => {
	const file = readFileSync(
		join(import.meta.dir, '..', '.env.example'),
		'utf8',
	);
	const documented = envNames(file.split('\n'));
	const expected = envNames(specToEnvExampleLines(QB_SPEC));

	// The convention itself, pinned at the app boundary.
	expect(expected).toEqual([
		'QB_SANDBOX_CLIENT_ID',
		'QB_SANDBOX_CLIENT_SECRET',
		'QB_PRODUCTION_CLIENT_ID',
		'QB_PRODUCTION_CLIENT_SECRET',
	]);
	// The file neither drifts from nor duplicates the spec.
	expect([...documented].sort()).toEqual([...expected].sort());
});
