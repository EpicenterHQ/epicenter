/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850,
 * ADR-0953). With `--json`, stdout is one JSON value: an action's answer,
 * exactly `{ data, error }`, a listing, a sync's report, or an operational
 * error. MCP gets the action's answer. Without it, stdout renders the
 * returned value by its structure. Stderr carries what went wrong, with a
 * `Run: <next step>` line where there is one.
 */
import { ActionError, type Answer } from '@epicenter/app';
import type { CliError } from './errors.ts';

export type { Answer } from '@epicenter/app';

const CAUSES = {
	Usage: 'usage',
	Refused: 'usage',
	AppProblems: 'app-problems',
	GitFailed: 'internal',
	Internal: 'internal',
} as const;

/** A check the CLI or serve made before an action began, as the answer that says it never did. */
export function notStarted(error: CliError): Answer {
	return ActionError.NotStarted({
		message: error.message,
		cause: CAUSES[error.name],
		next: 'next' in error ? error.next : undefined,
		problems: 'problems' in error ? error.problems : undefined,
	});
}

/** Write the one JSON answer to stdout. */
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

/** Render a successful value or a failure diagnostic for the terminal. */
export function renderAnswer(answer: Answer) {
	const result = outcome(answer);
	return result.code === 0
		? { ...readable(result.data), code: result.code }
		: { stdout: '', stderr: result.stderr, code: result.code };
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
function readable(value: unknown): { stdout: string; stderr: string } {
	const line = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);
	if (Array.isArray(value) && value.length === 0)
		return { stdout: '', stderr: '' };
	if (typeof value === 'string') return { stdout: line(value), stderr: '' };
	if (isFields(value)) {
		const fields = fieldLines(value);
		return { stdout: fields.length ? line(fields.join('\n')) : '', stderr: '' };
	}
	if (isRows(value)) return { stdout: line(rows(value)), stderr: '' };
	return { stdout: line(JSON.stringify(value)), stderr: '' };
}

/** Present an answer, as one JSON value or for a person, and return its exit code. */
export function presentAnswer(answer: Answer, json: boolean): number {
	if (json) {
		writeJson(answer);
		return outcome(answer).code;
	}
	const { stdout, stderr, code } = renderAnswer(answer);
	process.stdout.write(stdout);
	process.stderr.write(stderr);
	return code;
}

/**
 * Present a command other than an action call that did not run, exit 2. With
 * `--json` it prints `{ error }`, the `CliError` itself.
 */
export function fail(error: CliError, json: boolean): number {
	if (json) writeJson({ error });
	else process.stderr.write(renderAnswer(notStarted(error)).stderr);
	return 2;
}
