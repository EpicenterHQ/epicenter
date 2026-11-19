/**
 * Where the command and serve write. Every command ends in one answer,
 * `{ data, error }`: stdout prints `data`, text as it is and anything else
 * as JSON, and stderr prints an error's message, with a `Run: <next step>`
 * line where there is one. The exit code is 0 for success, 2 when the
 * action never began (`NotStarted`), and 1 otherwise.
 */

import type { LogSink } from 'wellcrafted/logger';
import type { Answer } from '../answer.ts';

/** Write diagnostics apart from the answer. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * A log sink that writes each event to stderr as one JSON line, its time as
 * ISO-8601, so whatever runs serve decides where its records go.
 */
export const stderrJsonLines: LogSink = (event) => {
	process.stderr.write(
		`${JSON.stringify(
			{ ...event, ts: new Date(event.ts).toISOString() },
			(_key, value) =>
				value instanceof Error
					? { name: value.name, message: value.message }
					: value,
		)}\n`,
	);
};

/** What a person reads for an error: its message, then the next step when there is one. */
export function errorText(error: { message: string; next?: unknown }) {
	return typeof error.next === 'string' && error.next
		? `${error.message}\nRun: ${error.next}`
		: error.message;
}

/** Print an answer and return its exit code. */
export function printAnswer(answer: Answer) {
	const { data, error } = answer;
	if (error !== null) {
		writeErr(errorText(error));
		return error.name === 'NotStarted' ? 2 : 1;
	}
	if (data === null || data === undefined) return 0;
	const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
	return 0;
}
