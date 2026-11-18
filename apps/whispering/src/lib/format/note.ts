/**
 * A note's text, read and written in the home's Markdown grammar from its
 * one owner, `@epicenter/app/markdown` (ADR-0894, ADR-0924): front matter of
 * `key: <JSON>` lines between `---` fences, then the body. A note Whispering
 * writes is one `epicenter check` reads, and both builds share this reader.
 *
 * A change rewrites only the lines of the keys it names (`withFields`), so
 * a key Whispering does not know and a line whose text is not JSON stay as
 * they are. Front matter that cannot be read is never rewritten.
 */
import {
	type FieldValues,
	type JsonValue,
	markdownOf,
	readMarkdown,
	withFields,
} from '@epicenter/app/markdown';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** Why a note's text does not read: the key and line involved, when there is one. */
export type NoteRefusal = {
	readonly reason: string;
	readonly field?: string;
	readonly line?: number;
};

/** A note as read: its fields and its body. */
export type ParsedNote = {
	readonly fields: FieldValues;
	readonly body: string;
};

/**
 * `text` read as a note: its fields and body, or why not. A text that does
 * not open with `---` is all body. Front matter that cannot be read (no
 * closing fence, a line that is not `key: <text>`, a key twice) and a line
 * whose text is not JSON are refused, so a person can repair them.
 */
export function parseNote(text: string): Result<ParsedNote, NoteRefusal> {
	const read = readMarkdown(text);
	if (!read.readable)
		return Err({
			reason:
				'The front matter does not read: each line between the --- fences is key: value, each key once, and a closing --- ends it',
		});
	const [notJson] = read.notJson;
	if (notJson !== undefined)
		return Err({
			reason: `${notJson.key} is not a JSON value: ${notJson.text}`,
			field: notJson.key,
			line: notJson.line,
		});
	return Ok({ fields: read.fields, body: read.body });
}

/** `fields` without the keys whose value is `undefined`, which means absent. */
const defined = (fields: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as FieldValues;

/** `fields` with the keys `order` names first, in its order, then the rest as given. */
function ordered(fields: FieldValues, order: readonly string[]): FieldValues {
	const rank = (key: string) => {
		const at = order.indexOf(key);
		return at < 0 ? order.length : at;
	};
	return Object.fromEntries(
		Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b)),
	);
}

/** A new note's text: `fields` in the order `order` names, then `body`. */
export function newNote(
	fields: Record<string, unknown>,
	body: string,
	order: readonly string[],
): string {
	return markdownOf(ordered(defined(fields), order), body);
}

/**
 * `text` with `changes` made: each named field set (`undefined` removes
 * it), the body replaced when given, and every other line as it was. The
 * caller has read `text` with `parseNote`, so its front matter reads.
 */
export function changeNote(
	text: string,
	changes: Record<string, unknown>,
	body: string | undefined,
): string {
	const given: FieldValues = {};
	const removed: string[] = [];
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) removed.push(key);
		else given[key] = value as JsonValue;
	}
	const changed = withFields(text, given, removed);
	if (body === undefined) return changed;
	const kept = readMarkdown(changed).body;
	return changed.slice(0, changed.length - kept.length) + body;
}

/** The 1-based line of `key`'s front matter line in `text`, when it has one. */
export function lineOf(text: string, key: string): number | undefined {
	const lines = text.split('\n');
	if (lines[0]?.replace(/\r$/, '') !== '---') return undefined;
	for (let index = 1; index < lines.length; index++) {
		const line = (lines[index] as string).replace(/\r$/, '');
		if (line === '---') return undefined;
		if (line.startsWith(`${key}:`)) return index + 1;
	}
	return undefined;
}
