/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850,
 * ADR-0953). Every command, an action call or one of the CLI's own, ends in
 * one answer, exactly `{ data, error }`. With `--json`, stdout is that
 * answer; MCP gets an action's. Without it, stdout renders `data` by its
 * structure, and a command's own text prints as it is. Stderr carries what
 * went wrong, with a `Run: <next step>` line where there is one.
 */
import type { Answer } from '@epicenter/app';
import type { LogSink } from 'wellcrafted/logger';

export type { Answer } from '@epicenter/app';

/** Write diagnostics separately from the answer or MCP protocol. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * A log sink that writes each event to stderr as one JSON line, its time as
 * ISO-8601. stdout stays the command's output; whatever runs serve decides
 * where stderr goes. A native `Error` is written as its name and message,
 * since JSON would otherwise make it `{}`.
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

/**
 * Classify the answer once for CLI exit codes and MCP tool errors: 0 for
 * success, 2 for exactly `NotStarted`, and 1 for every other error.
 */
export function outcome(
	answer: Answer,
): { code: 0; data: unknown } | { code: 1 | 2; stderr: string } {
	const { data, error } = answer;
	if (error === null) return { code: 0, data };
	const { next } = error as { next?: unknown };
	return {
		code: error.name === 'NotStarted' ? 2 : 1,
		stderr:
			typeof next === 'string' && next
				? `${error.message}\nRun: ${next}\n`
				: `${error.message}\n`,
	};
}

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A string as it reads after `key: `: plain, unless it could be read as
 * something else, such as JSON (`"true"`, `"12"`, `"null"`), an empty or
 * padded string, or one that starts as a quote or a block would.
 */
function stringValue(value: string): string {
	if (
		value === '' ||
		value.trim() !== value ||
		/^["'|]/.test(value) ||
		looksLikeJson(value)
	)
		return JSON.stringify(value);
	return value;
}

function looksLikeJson(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

/** A non-empty list whose every item is an object. */
const isRows = (value: unknown): value is Fields[] =>
	Array.isArray(value) && value.length > 0 && value.every(isFields);

/** `text` moved two spaces right, leaving blank lines blank. */
const indent = (text: string) =>
	text
		.split('\n')
		.map((line) => (line ? `  ${line}` : line))
		.join('\n');

/**
 * Each defined field as `key: value`. A string of several lines is a block
 * under `key: |`; an object with a field, or a non-empty list of objects,
 * renders as a returned one would, two spaces in under `key:`. Anything else
 * is compact JSON.
 */
function fieldLines(fields: Fields): string[] {
	return Object.entries(fields)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => {
			if (typeof value === 'string')
				return value.includes('\n')
					? `${key}: |\n${indent(value.replace(/\n$/, ''))}`
					: `${key}: ${stringValue(value)}`;
			const nested = isFields(value)
				? fieldLines(value).join('\n')
				: isRows(value)
					? rows(value)
					: '';
			return nested
				? `${key}:\n${indent(nested)}`
				: `${key}: ${JSON.stringify(value)}`;
		});
}

/**
 * A list of objects, one row each with its fields side by side, unless a
 * field takes more than one line: then each is a block of field lines, the
 * blocks apart by a blank line.
 */
function rows(items: Fields[]): string {
	const each = items.map(fieldLines);
	const blocks = each.some((lines) =>
		lines.some((line) => line.includes('\n')),
	);
	return each
		.map((lines) => lines.join(blocks ? '\n' : '  '))
		.join(blocks ? '\n\n' : '\n');
}

/** Render the returned value without assuming what its keys mean. */
function readable(value: unknown): string {
	const line = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);
	if (Array.isArray(value) && value.length === 0) return '';
	if (typeof value === 'string') return line(value);
	if (isFields(value)) {
		const fields = fieldLines(value);
		return fields.length ? line(fields.join('\n')) : '';
	}
	if (isRows(value)) return line(rows(value));
	return line(JSON.stringify(value));
}

/**
 * Present an answer and return its exit code. With `json`, stdout is the one
 * JSON answer. Without it, success data renders on stdout, and an error's
 * message and next step go to stderr. An error that carries a `report`, as
 * `Problems` does, renders that report on stdout the way data renders.
 */
export function presentAnswer(answer: Answer, json: boolean): number {
	const result = outcome(answer);
	if (json)
		process.stdout.write(
			`${JSON.stringify({ data: answer.data, error: answer.error })}\n`,
		);
	else if (result.code === 0) process.stdout.write(readable(result.data));
	else {
		const { report } = answer.error as { report?: unknown };
		if (report !== undefined) process.stdout.write(readable(report));
		process.stderr.write(result.stderr);
	}
	return result.code;
}
