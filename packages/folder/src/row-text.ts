/**
 * Rows as text for the CLI's definition-based reader. Public Folder tables
 * use `shared/row.ts` to expose source and repairable issues.
 *
 * Both functions take a table of a prepared folder definition, the one
 * `defineFolder` returns, so they work with no storage at all. The CLI's
 * `readFolder` calls `parseRow` for each table file it finds.
 *
 *     const definition = defineFolder({ tables: { todos } });
 *     const { data: row, error: issues } = parseRow(definition.tables.todos, text);
 *     const { data: saved } = formatRow(definition.tables.todos, row);
 *
 * A row's body has `\n` line endings: `parseRow` reads `\r\n` and lone `\r`
 * as `\n`, and `formatRow` writes `\n` (ADR-0572). `formatRow` also writes
 * each unpaired surrogate in a string as U+FFFD, as UTF-8 encoding would, so
 * an editor passes typed text as it is.
 *
 * `formatRow` writes one fixed text for a row: declared keys first in
 * declared order, then other keys, then the body. Text that `formatRow`
 * writes always reads back through `parseRow` as the row it stored.
 */

import { type CheckMode, type CreateRowOf, check } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalDocument,
	type CanonicalRefusal,
	formatRowSource,
	parseRowSource,
} from './canonical.js';
import type { PreparedFolderTable } from './definition.js';

/**
 * The editable part of a row: every frontmatter field, unknown keys
 * included, and the Markdown body after the closing fence. A caller owns it,
 * so its top-level fields are assignable even where a definition's types are
 * readonly.
 */
export type Row<TFields> = {
	fields: { -readonly [K in keyof TFields]: TFields[K] };
	body: string;
};

/**
 * One reason text is not a valid row, located like a compiler diagnostic.
 * The message stands alone; neither its wording nor the number of issues is
 * a machine contract.
 */
export type Issue = {
	readonly message: string;
	/** The 1-based line in the whole text. Absent only for a declared field the text lacks. */
	readonly line?: number;
	/** The top-level frontmatter key involved, when there is one. */
	readonly field?: string;
};

/** Why text is not a valid row: never empty, in line order. */
export type Issues = readonly [Issue, ...Issue[]];

/**
 * How a row's stored keys are checked. An open table ignores a key it does not
 * declare and keeps it; a closed one reads its file as strictly as a whole row
 * is written, so an undeclared key is an issue at its line.
 */
function storedMode(table: PreparedFolderTable): CheckMode {
	return table.additionalProperties === false ? 'input' : 'read';
}

/**
 * Read text as a row of a prepared table: parse the complete frontmatter,
 * then check every declared field. Synchronous and pure, so it reads an
 * unsaved buffer as readily as a file.
 *
 * Text that has no canonical form fails with exactly one issue: the first
 * problem the parser met. Text that parses fails with one issue for each way
 * a declared field does not conform or is missing, at the line of the value
 * the validator names, or else of its key. Keys the table does not declare
 * are kept and never an issue.
 *
 * A valid row's values are this parse's own: mutable, shared with nothing,
 * and with unknown keys still on `fields`, so a caller can edit them and save
 * the complete row. Validation never changes them.
 */
export function parseRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	text: string,
): Result<Row<CreateRowOf<TTable>>, Issues> {
	const { data: parsed, error: refusal } = parseRowSource(text);
	if (refusal !== null)
		return Err(
			issueList([
				{ message: refusal.reason, line: refusal.line, field: refusal.field },
			]),
		);
	const { document, lineOf } = parsed;
	const { issues } = check(table.fields, document.fields, storedMode(table));
	if (issues.length > 0)
		return Err(
			issueList(
				issues.map(({ field, path, message }) => ({
					message,
					line: lineOf(field, path),
					field,
				})),
			),
		);
	return Ok({
		fields: document.fields as Row<CreateRowOf<TTable>>['fields'],
		body: lineFeeds(document.body),
	});
}

/**
 * The text a row is saved as. Refused, with one issue, when a value has no
 * exact form in a file: `NaN`, a `Date`, a class instance, or a cycle. The
 * body is written with `\n` line endings, and each unpaired surrogate in a
 * string becomes U+FFFD. Fields are not checked against the schema, so a
 * draft the person is still typing formats as typed; `parseRow` of the text
 * reports whether it is a valid row.
 *
 * Only `fields` and `body` are read, once each, before this returns: later
 * changes to the row change nothing about the text.
 */
export function formatRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	row: Row<CreateRowOf<TTable>>,
): Result<string, Issue> {
	const { data: written, error: refusal } = formatRowSource(
		storable(row) as unknown as CanonicalDocument,
		Object.keys(table.fields),
	);
	if (refusal === null) return Ok(written.text);
	return Err(writeIssue(refusal));
}

const LONE_SURROGATE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text as a file can hold it: each unpaired surrogate becomes U+FFFD, as
 * UTF-8 encoding would. A row's strings get this when it is written; raw
 * text saved through `files` keeps its own.
 */
export function wellFormed(text: string): string {
	return text.replace(LONE_SURROGATE, '\uFFFD');
}

/** Text with each `\r\n` and lone `\r` as `\n`. */
export function lineFeeds(text: string): string {
	return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

/**
 * `row` as a file holds it: the body with `\n` line endings, and every
 * string, at any depth, well-formed. A row that needs neither is returned
 * as it is.
 */
function storable<TRow extends { fields: object; body: string }>(
	row: TRow,
): TRow {
	const body = wellFormed(lineFeeds(row.body));
	const fields = storableValue(row.fields) as TRow['fields'];
	if (body === row.body && fields === row.fields) return row;
	return { ...row, fields, body };
}

/** `value` with every string well-formed; the same value when none changes. */
function storableValue(value: unknown): unknown {
	if (typeof value === 'string') return wellFormed(value);
	if (Array.isArray(value)) {
		const items = value.map(storableValue);
		return items.some((item, index) => item !== value[index]) ? items : value;
	}
	if (value === null || typeof value !== 'object') return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	let changed = false;
	const entries = Object.entries(value).map(([key, item]) => {
		const next = storableValue(item);
		if (next !== item) changed = true;
		return [key, next] as const;
	});
	return changed ? Object.fromEntries(entries) : value;
}

/** Why a row cannot be written, as an issue about its field when it names one. */
function writeIssue(refusal: CanonicalRefusal): Issue {
	return Object.freeze(
		refusal.field === undefined
			? { message: `The row cannot be saved: ${refusal.reason}` }
			: {
					message: `${refusal.field} cannot be saved: ${refusal.reason}`,
					field: refusal.field,
				},
	);
}

/** Frozen issues without absent keys, in line order; an issue with no line goes last. */
function issueList(
	issues: readonly { message: string; line?: number; field?: string }[],
): Issues {
	const located = issues.map(({ message, line, field }) =>
		Object.freeze({
			message,
			...(line === undefined ? {} : { line }),
			...(field === undefined ? {} : { field }),
		}),
	);
	located.sort(
		(a, b) =>
			(a.line ?? Number.POSITIVE_INFINITY) -
			(b.line ?? Number.POSITIVE_INFINITY),
	);
	return Object.freeze(located) as unknown as Issues;
}
