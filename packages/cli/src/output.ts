/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850).
 * With `--json`, stdout is one JSON value: a run's answer, a listing, a
 * sync's report, or `{ error }` when nothing ran; MCP gets the same value.
 * Without it, stdout carries only what a person reads as the answer, and
 * stderr carries what went wrong, with a `Run: <next step>` line wherever
 * there is one.
 */
import { type Report, writeReport } from './child.ts';
import type { CliError } from './errors.ts';

/**
 * What a command that runs an action answers (ADR-0850): the one value
 * `--json` prints, MCP returns as `structuredContent`, and stderr renders.
 * Whether it returned or threw, what the action wrote stays in the folder
 * until a snapshot takes it into the app's history.
 */
export type Answer =
	/** The action returned this value; `null` for nothing. */
	| { returned: unknown }
	/**
	 * The action threw, or the run ended without an answer. A thrown tagged
	 * error (`{ name, message, ...fields }`) is kept whole as `thrown`.
	 */
	| { threw: { message: string; thrown?: Record<string, unknown> } }
	/** Nothing ran: the words, the input, or the app was wrong. */
	| { error: { name: string; message: string; next?: string } };

/** The report file this process answers into, when it is a child (`child.ts`). */
let reportPath: string | undefined;

/** Make this process a child: its one JSON answer goes to `path`, never to stdout. */
export function answerInto(path: string) {
	reportPath = path;
}

/**
 * Write the one JSON answer: to stdout, or to the report file in a child,
 * with the app a write run wrote, for the parent to snapshot.
 */
export function writeJson(value: unknown, wrote?: Report['wrote']) {
	if (reportPath)
		writeReport(reportPath, { answer: value, ...(wrote ? { wrote } : {}) });
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
 * An answer as a person reads it, and its exit code: a returned value on
 * stdout, and on stderr what the action threw, or why nothing ran with its
 * next step. 0: it returned. 1: it threw, or ended without an answer. 2: it
 * did not run.
 */
export function renderAnswer(answer: Answer): {
	stdout: string;
	stderr: string;
	code: 0 | 1 | 2;
} {
	if ('error' in answer) {
		const { message, next } = answer.error;
		return {
			stdout: '',
			stderr: `${message}\n${next ? `Run: ${next}\n` : ''}`,
			code: 2,
		};
	}
	if ('threw' in answer)
		return { stdout: '', stderr: `${answer.threw.message}\n`, code: 1 };
	const { returned } = answer;
	if (returned === null) return { stdout: '', stderr: '', code: 0 };
	const text =
		typeof returned === 'string' ? returned : JSON.stringify(returned, null, 2);
	return {
		stdout: text.endsWith('\n') ? text : `${text}\n`,
		stderr: '',
		code: 0,
	};
}

/** Present an answer, as one JSON value or for a person, and return its exit code. */
export function presentAnswer(
	answer: Answer,
	json: boolean,
	wrote?: Report['wrote'],
): number {
	const { stdout, stderr, code } = renderAnswer(answer);
	if (json) writeJson(answer, wrote);
	else {
		process.stdout.write(stdout);
		process.stderr.write(stderr);
	}
	return code;
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
