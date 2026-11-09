/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850).
 * With `--json`, stdout is one JSON value: a run's answer, a listing, a
 * sync's report, or `{ error }` when nothing ran; MCP gets the same value.
 * Without it, stdout carries only what a person reads as the answer, and
 * stderr carries what went wrong, with a `Run: <next step>` line wherever
 * there is one.
 */
import { writeReport } from './child.ts';
import type { CliError } from './errors.ts';
import { type Answer, exitCodeOf } from './report.ts';

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

/** Write an answer with a final newline for a person reading the command. */
export function writeOut(text: string) {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write diagnostics separately from the answer or MCP protocol. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * An answer as a person reads it: a returned value on stdout, and on stderr
 * what the action threw, or why nothing ran with its next step.
 */
export function renderAnswer(answer: Answer): {
	stdout: string;
	stderr: string;
} {
	if ('error' in answer) {
		const { message, next } = answer.error;
		return {
			stdout: '',
			stderr: `${message}\n${next ? `Run: ${next}\n` : ''}`,
		};
	}
	if ('threw' in answer)
		return { stdout: '', stderr: `${answer.threw.message}\n` };
	const { returned } = answer;
	if (returned === null) return { stdout: '', stderr: '' };
	const text =
		typeof returned === 'string' ? returned : JSON.stringify(returned, null, 2);
	return { stdout: text.endsWith('\n') ? text : `${text}\n`, stderr: '' };
}

/** Present an answer, as one JSON value or for a person, and return its exit code. */
export function presentAnswer(answer: Answer, json: boolean): number {
	if (json) writeJson(answer);
	else {
		const { stdout, stderr } = renderAnswer(answer);
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return exitCodeOf(answer);
}

/** Present a command that did not run, exit 2. */
export function fail(error: CliError, json: boolean): number {
	return presentAnswer({ error }, json);
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
