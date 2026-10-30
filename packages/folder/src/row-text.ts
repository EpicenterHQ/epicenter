/**
 * CLI rows validate against the complete portable table schema. Applications
 * use shared/row.ts and source-preserving Folder saves.
 */

import { parseRowSource } from '@epicenter/definition/note';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	compileTableSchema,
	type PortableTableSchema,
} from './declaration-schema.js';

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

/** The CLI validates a portable table as one schema, retaining root reference scope. */
export function parseDeclaredRow(
	schema: PortableTableSchema,
	text: string,
): Result<Row<Record<string, unknown>>, Issues> {
	const parsed = parseRowSource(text);
	if (parsed.error !== null)
		return Err(
			issueList([
				{
					message: parsed.error.reason,
					line: parsed.error.line,
					field: parsed.error.field,
				},
			]),
		);
	const { document, lineOf } = parsed.data;
	try {
		const validator = compileTableSchema(schema);
		if (validator.Check(document.fields))
			return Ok({ fields: document.fields, body: lineFeeds(document.body) });
		return Err(
			issueList(
				validator.Errors(document.fields).flatMap<Issue>((issue) => {
					if (issue.instancePath === '' && issue.keyword === 'required') {
						const missing = issue.params.requiredProperties as string[];
						return missing.map((field) => ({
							field,
							message: `${field} is missing`,
						}));
					}
					if (
						issue.instancePath === '' &&
						issue.keyword === 'additionalProperties'
					) {
						const extra = issue.params.additionalProperties as string[];
						return extra.map((field) => ({
							field,
							message: `${field} is not declared`,
							line: lineOf(field),
						}));
					}
					// TypeBox emits raw slash-joined paths. Ambiguous field names get no invented location.
					const candidates = Object.keys(document.fields).filter(
						(field) =>
							issue.instancePath === `/${field}` ||
							issue.instancePath.startsWith(`/${field}/`),
					);
					const field = candidates.length === 1 ? candidates[0] : undefined;
					return [
						{
							message:
								field === undefined
									? issue.message
									: `${field} does not conform: ${issue.message}`,
							...(field === undefined ? {} : { field, line: lineOf(field) }),
						},
					];
				}),
			),
		);
	} catch (cause) {
		return Err([
			{ message: `The row could not be validated: ${String(cause)}` },
		]);
	}
}

/** CLI output keeps the historical normalized body representation. Source stays unchanged. */
function lineFeeds(text: string): string {
	return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
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
