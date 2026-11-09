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
import { type Answer, exitCodeOf, type PathState } from './report.ts';

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

/**
 * An answer as a person reads it: a run's returned value on stdout, and on
 * stderr what was committed, left uncommitted, refused, or pushed, the error,
 * and a `Run: <next step>` line wherever there is one.
 */
export function renderAnswer(answer: Answer): {
	stdout: string;
	stderr: string;
} {
	const lines: string[] = [];
	let stdout = '';
	if ('error' in answer) {
		const { message, next } = answer.error;
		lines.push(message, ...(next ? [`Run: ${next}`] : []));
	} else if ('unknown' in answer) {
		const { message, head } = answer.unknown;
		lines.push(
			message,
			`HEAD before: ${head.before ?? '(none)'}`,
			`HEAD now: ${head.after ?? '(none)'}`,
		);
	} else {
		const { commit, push, action } = answer;
		if (commit && 'failed' in commit)
			lines.push(`Could not commit the action's writes: ${commit.failed}`);
		else if (commit)
			lines.push(`committed ${commit.sha.slice(0, 7)} ${commit.subject}`);
		for (const { path, state } of answer.paths)
			if (LEFT[state]) lines.push(`left uncommitted: ${path} (${LEFT[state]})`);
		for (const { message, next } of answer.refused)
			lines.push(message, ...(next ? [`Run: ${next}`] : []));
		if (push?.pushed) lines.push('pushed to origin');
		else if (push)
			lines.push(
				`not pushed: ${push.reason}`,
				...(push.next ? [`Run: ${push.next}`] : []),
			);
		if ('threw' in action) lines.push(action.threw.message);
		else if (typeof action.returned === 'string')
			stdout = action.returned.endsWith('\n')
				? action.returned
				: `${action.returned}\n`;
		else if (action.returned !== null)
			stdout = `${JSON.stringify(action.returned, null, 2)}\n`;
	}
	return { stdout, stderr: lines.map((line) => `${line}\n`).join('') };
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
