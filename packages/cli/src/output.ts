/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850).
 * With `--json`, stdout is one JSON value: a run's report, a listing, or
 * `{ error }` when nothing ran; MCP gets the same value. Without it, stdout
 * carries only the answer a person reads, and stderr is a rendering of the
 * same value: what was committed, left uncommitted, refused, or pushed, and a
 * `Run: <next step>` line wherever there is one.
 */
import { writeReport } from './child.ts';
import type { CliError } from './errors.ts';
import {
	exitCodeOf,
	type PathState,
	type RunReport,
	type Unknown,
} from './report.ts';

/** The report file this process answers into, when it is a child (`child.ts`). */
let reportPath: string | undefined;

/** Make this process a child: its one JSON answer goes to `path`, never to stdout. */
export function answerInto(path: string) {
	reportPath = path;
}

/** Write the one JSON answer: to stdout, or to the report file in a child. */
export function writeJson(value: unknown) {
	if (reportPath) writeReport(reportPath, { answer: value });
	else process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** In a child, record that the run has begun, so a child that dies after it still says what landed. */
export function writeStarted(started: { folder: string; head: string | null }) {
	if (reportPath) writeReport(reportPath, { started });
}

/** Write an answer with a final newline for a person reading the command. */
export function writeOut(text: string) {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write diagnostics separately from the answer or MCP protocol. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Why a path the action wrote is not as it left it in history, for a person. */
const LEFT: Partial<Record<PathState, string>> = {
	'changed-after': 'changed after the action wrote it',
	contested: 'a commit made during the run changed it too',
	'not-committed': 'the commit failed',
};

/** A run's report as a person reads it: the returned value on stdout, everything else on stderr. */
export function renderReport(report: RunReport): {
	stdout: string;
	stderr: string;
} {
	const lines: string[] = [];
	const { commit } = report;
	if (commit && 'failed' in commit)
		lines.push(`Could not commit the action's writes: ${commit.failed}`);
	else if (commit)
		lines.push(`committed ${commit.sha.slice(0, 7)} ${commit.subject}`);
	for (const { path, state } of report.paths)
		if (LEFT[state]) lines.push(`left uncommitted: ${path} (${LEFT[state]})`);
	for (const { message, next } of report.refused)
		lines.push(message, ...(next ? [`Run: ${next}`] : []));
	const { push } = report;
	if (push?.pushed) lines.push('pushed to origin');
	else if (push)
		lines.push(
			`not pushed: ${push.reason}`,
			...(push.next ? [`Run: ${push.next}`] : []),
		);
	let stdout = '';
	if ('threw' in report.action) lines.push(report.action.threw.message);
	else {
		const { returned } = report.action;
		if (typeof returned === 'string')
			stdout = returned.endsWith('\n') ? returned : `${returned}\n`;
		else if (returned !== null)
			stdout = `${JSON.stringify(returned, null, 2)}\n`;
	}
	return {
		stdout,
		stderr: lines.map((line) => `${line}\n`).join(''),
	};
}

/** Present a run's report and return its exit code. */
export function presentReport(report: RunReport, json: boolean): number {
	if (json) writeJson(report);
	else {
		const { stdout, stderr } = renderReport(report);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return exitCodeOf(report);
}

/** Present a run whose child ended without a report: exit 3, with the heads that say what landed. */
export function presentUnknown(value: Unknown, json: boolean): number {
	if (json) writeJson(value);
	else {
		const { message, head } = value.unknown;
		writeErr(message);
		writeErr(`HEAD before: ${head.before ?? '(none)'}`);
		writeErr(`HEAD now: ${head.after ?? '(none)'}`);
	}
	return 3;
}

/** Present what a child answered: a report, an unknown end, a refusal to run, or a listing. */
export function presentAnswer(answer: unknown, json: boolean): number {
	const value = answer as Record<string, unknown>;
	if ('error' in value) return fail(value.error as CliError, json);
	if ('unknown' in value) return presentUnknown(value as Unknown, json);
	if ('action' in value) return presentReport(value as RunReport, json);
	writeJson(value);
	return 0;
}

/** Present a command that did not run, exit 2. */
export function fail(error: CliError, json: boolean): number {
	if (json) writeJson({ error });
	else {
		writeErr(error.message);
		const next = (error as { next?: string }).next;
		if (next) writeErr(`Run: ${next}`);
	}
	return 2;
}

/** Present a command that made something: its answer on stdout, its next step on stderr. */
export function made(
	value: { folder: string; next: string } & Record<string, unknown>,
	json: boolean,
): number {
	const { next, ...answer } = value;
	if (json) writeJson(answer);
	else {
		writeOut(value.folder);
		writeErr(`Run: ${next}`);
	}
	return 0;
}
