/**
 * `epicenter matter`: work with a folder of typed markdown as a SQLite-backed table, backed by
 * `@epicenter/matter-core`. Disk is the source of truth; the SQLite mirror is a read-only projection
 * (ADR-0026, ADR-0065). Namespaced under `epicenter` so the disk-as-truth verbs stay quarantined from
 * workspace and Yjs verbs.
 *
 * Today the one subcommand is `check`. `query`, `add`, and an MCP server are deferred (see the launch
 * spec's Adjacent Work).
 */

import {
	assess,
	describeExpected,
	exitCodeFor,
	formatReport,
	type Summary,
	summarize,
	toViolations,
	type Violation,
} from '@epicenter/matter-core';
import { loadPath } from '@epicenter/matter-core/fs';
import { cmd } from '../util/cmd.js';

/**
 * The serializable form of a violation. Every kind is already plain JSON except `invalid-type`, which
 * carries the loaded Field; that is projected to its name plus the computed expected value, so
 * `describeExpected` runs here at the JSON edge and the Field never leaks out.
 */
function serializeViolation(violation: Violation): unknown {
	if (violation.kind !== 'invalid-type') return violation;
	return {
		kind: violation.kind,
		table: violation.table,
		row: violation.row,
		field: violation.field.name,
		raw: violation.raw,
		expected: describeExpected(violation.field),
	};
}

/** The note block for references a single-table check could not evaluate. Empty when there are none. */
function unevaluableNote(unevaluable: readonly Violation[]): string {
	if (unevaluable.length === 0) return '';
	const lines = unevaluable.map((violation) =>
		violation.kind === 'missing-target'
			? `  ${violation.field} -> ${violation.target}`
			: `  ${violation.field}`,
	);
	return [
		'note: references not checked when checking a single table; run on the whole vault to resolve',
		...lines,
	].join('\n');
}

function writeText(
	summary: Summary,
	failures: readonly Violation[],
	unevaluable: readonly Violation[],
): void {
	const note = unevaluableNote(unevaluable);
	const report = formatReport(failures, summary);
	process.stdout.write(`${note ? `${report}\n\n${note}` : report}\n`);
}

function writeJson(
	summary: Summary,
	failures: readonly Violation[],
	unevaluable: readonly Violation[],
): void {
	const payload = {
		violations: failures.map(serializeViolation),
		unevaluableReferences: unevaluable.map(serializeViolation),
		summary,
	};
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * `epicenter matter check [path]`: certify a vault's integrity. Point it at one marked table folder to
 * check that table, or at a folder of tables to check them all, references and all (ADR-0029/0032). The
 * path becomes `TableInput[]`, `assess` classifies it once, and the report renders to human text, the
 * `--json`, and the exit code, so every surface agrees by construction.
 *
 * Exit codes: 0 every loaded row is healthy; 1 a row needs attention or a reference does not resolve;
 * 2 a folder or Markdown file is unreadable, or a `matter.json` is a corrupt contract.
 *
 * A lone table (one folder, no siblings loaded) cannot resolve cross-table references, so every
 * reference reads as `missing-target`: those are surfaced as a note, never a failure.
 */
const checkCommand = cmd({
	command: 'check [path]',
	describe: 'Lint a vault: conformance and reference integrity.',
	builder: (yargs) =>
		yargs
			.positional('path', {
				type: 'string',
				default: '.',
				defaultDescription: 'current directory',
				describe: 'A marked table folder, or a folder of tables',
			})
			.option('json', {
				type: 'boolean',
				default: false,
				describe: 'Emit machine-readable violations instead of text',
			})
			.strict(),
	handler: async (argv) => {
		const tables = await loadPath(argv.path);
		const integrity = assess(tables);
		const summary = summarize(integrity);
		const violations = toViolations(integrity);

		// A lone table (no sibling tables in scope) cannot load any target table, so every reference is
		// missing-target and un-evaluable in isolation: hold those out of the failures as notes.
		// (dangling cannot occur for a lone table; it needs the target table present.)
		const isLoneTable = tables.length === 1;
		const unevaluable = isLoneTable
			? violations.filter((violation) => violation.kind === 'missing-target')
			: [];
		const failures = isLoneTable
			? violations.filter((violation) => violation.kind !== 'missing-target')
			: violations;

		if (argv.json) {
			writeJson(summary, failures, unevaluable);
		} else {
			writeText(summary, failures, unevaluable);
		}
		process.exitCode = exitCodeFor(summary, failures);
	},
});

export const matterCommand = cmd({
	command: 'matter',
	describe:
		'Work with a folder of typed markdown: disk is the source, SQLite is a read-only projection.',
	builder: (yargs) =>
		yargs
			.command(checkCommand)
			.demandCommand(1, 'Specify a subcommand: check')
			.strict()
			.help(),
	handler: () => {},
});
