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

/**
 * What a command that runs an action answers (ADR-0850): the one value
 * `--json` prints, MCP returns as `structuredContent`, and stderr renders.
 * A run that returned from an action that writes commits what changed in
 * the app's folder, and the answer says which commit, or why there is none.
 */
export type Answer =
	/**
	 * The action returned this value; `null` for nothing. `committed` is the
	 * commit its writes made; `uncommitted` says why they were left in the
	 * folder when committing failed.
	 */
	| {
			returned: unknown;
			committed?: string;
			uncommitted?: { message: string; next: string };
	  }
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
 * An answer as a person reads it, and its exit code: a returned value on
 * stdout, and on stderr what the action threw, or why nothing ran with its
 * next step. 0: it returned, and its writes are committed or there were
 * none. 1: it threw, or ended without an answer. 2: it did not run. 3: it
 * returned, and its writes are not committed, so running it again would
 * repeat them (ADR-0867).
 */
export function renderAnswer(answer: Answer): {
	stdout: string;
	stderr: string;
	code: 0 | 1 | 2 | 3;
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
	const { returned, uncommitted } = answer;
	const stderr = uncommitted
		? `The action returned, but its changes were not committed: ${uncommitted.message}\nRun: ${uncommitted.next}\n`
		: '';
	const code = uncommitted ? 3 : 0;
	if (returned === null) return { stdout: '', stderr, code };
	const text =
		typeof returned === 'string' ? returned : JSON.stringify(returned, null, 2);
	return { stdout: text.endsWith('\n') ? text : `${text}\n`, stderr, code };
}

/** Present an answer, as one JSON value or for a person, and return its exit code. */
export function presentAnswer(answer: Answer, json: boolean): number {
	const { stdout, stderr, code } = renderAnswer(answer);
	if (json) writeJson(answer);
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
