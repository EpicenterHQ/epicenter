/**
 * The one place a run's outcome becomes what a caller sees (ADR-0842,
 * ADR-0850). stdout carries only the answer: the returned value, or one JSON
 * object with `--json`. stderr carries notes for a person: what was
 * committed, what was left uncommitted, refusals and errors, each followed by
 * a `Run: <next step>` line when there is one. MCP gets the same object.
 */
import type { CliError, Outcome } from './errors.ts';
import { exitCodeOf } from './errors.ts';
import type { Ran } from './run.ts';

/** Exit codes: 0 ran, 1 a finding, 2 did not run, 3 ran and failed or threw. */
export const EXIT = { ok: 0, finding: 1, unusable: 2, failed: 3 } as const;

/** Write one JSON answer per line so callers can read stdout directly. */
export function writeJson(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Write an answer with a final newline for a person reading the command. */
export function writeOut(text: string) {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write diagnostics separately from the answer or MCP protocol. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** The notes a person reads about what a run left behind. */
function outcomeNotes({ commit, uncommitted }: Partial<Outcome>) {
	return [
		...(commit
			? [`committed ${commit.sha.slice(0, 7)} ${commit.subject}`]
			: []),
		...(uncommitted ?? []).map(
			(path) => `left uncommitted: ${path} (changed during the run)`,
		),
	];
}

/** Present a failure and return its exit code, without forcing exit. */
export function fail(error: CliError, json: boolean): number {
	if (json) writeJson({ error });
	else {
		for (const note of outcomeNotes(error as Partial<Outcome>)) writeErr(note);
		writeErr(error.message);
		const next = (error as { next?: string }).next;
		if (next) writeErr(`Run: ${next}`);
	}
	return exitCodeOf(error);
}

/** Present a run that returned: its notes on stderr, its answer on stdout. */
export function ran(value: Ran, json: boolean): number {
	if (json) {
		writeJson(value);
		return EXIT.ok;
	}
	for (const note of outcomeNotes(value)) writeErr(note);
	if (typeof value.result === 'string') writeOut(value.result);
	else if (value.result !== undefined)
		writeOut(JSON.stringify(value.result, null, 2));
	return EXIT.ok;
}
