/**
 * The one place an answer becomes what a caller sees (ADR-0842, ADR-0850).
 * With `--json`, stdout is one JSON value: a run's answer, a listing, a
 * sync's report, or `{ error }` when nothing ran; MCP gets the same value.
 * Without it, stdout renders the returned value by its structure. Stderr
 * carries what went wrong, with a `Run: <next step>` line where there is one.
 */
import { type Report, writeReport } from './child.ts';
import type { CliError } from './errors.ts';

/**
 * What a command that runs an action answers (ADR-0850): the one value
 * `--json` prints and MCP returns as `structuredContent`.
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
 * next step. 0: it returned. 1: it
 * threw, or ended without an answer. 2: it did not run.
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
	return { ...readable(answer.returned), code: 0 };
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
