/**
 * A collection's file as fields and body (ADR-0796, ADR-0924). The grammar
 * is copied from the waiting product's front matter without its merge
 * (ADR-0843: new code copies from it, never imports it).
 *
 * A file has front matter when its first line is `---` and a later line is
 * `---`. Each line between them is `key: <text>`, each key once: a key is a
 * letter or `_`, then letters, digits, `_` or `-`, and the text is the rest
 * of the line after `: `, or nothing after a bare `key:`. A line ends at
 * `\n`, and a `\r` before it belongs to the ending.
 *
 * Each line is read on its own, and no YAML is read. Text that is JSON is
 * the key's value. Text that is not leaves the key absent, and the read lists
 * the line so a caller can say how to repair it. A file that opens with `---`
 * and has any other line before its closing fence, a key twice, or no
 * closing fence has front matter that cannot be read: its whole text is
 * body, and it is never rewritten.
 *
 * A write replaces only the lines of the keys it names, adds a new key before
 * the closing fence, and removes a deleted key's line. Every other line stays
 * byte for byte, a line whose text is not JSON included.
 */
/** A JSON value. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A front matter line: a key, then `:`, then nothing or a space and its text. */
const LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/s;

/** Whether `key` can name a field line. */
export const isFieldKey = (key: string) => KEY.test(key);

/** One `key: <text>` line as the file holds it, its number in the file, and its value when its text is JSON. */
type Field = {
	key: string;
	line: string;
	number: number;
	text: string;
	value: JsonValue | undefined;
};

/** A note split at its fences, each piece verbatim. */
type Parts = { open: string; fields: Field[]; close: string; body: string };

/** The note's pieces; `'none'` when it does not open with `---`, `'unreadable'` when its front matter cannot be read. */
function split(text: string): Parts | 'none' | 'unreadable' {
	const ending = (from: number) => {
		const lf = text.indexOf('\n', from);
		return lf < 0 ? text.length : lf + 1;
	};
	const content = (line: string) => line.replace(/\r?\n$/, '');
	const openEnd = ending(0);
	const open = text.slice(0, openEnd);
	if (content(open) !== '---' || !open.endsWith('\n')) return 'none';
	const fields: Field[] = [];
	const seen = new Set<string>();
	let number = 1;
	for (let at = openEnd; at < text.length; ) {
		number++;
		const end = ending(at);
		const line = text.slice(at, end);
		const raw = content(line);
		if (raw === '---')
			return { open, fields, close: line, body: text.slice(end) };
		const match = LINE.exec(raw);
		if (!match || !line.endsWith('\n')) return 'unreadable';
		const [, key = '', rest = ''] = match;
		if (seen.has(key)) return 'unreadable';
		seen.add(key);
		let value: JsonValue | undefined;
		try {
			value = JSON.parse(rest) as JsonValue;
		} catch {
			value = undefined;
		}
		fields.push({ key, line, number, text: rest, value });
		at = end;
	}
	return 'unreadable';
}

/**
 * A field's value as Epicenter writes it: JSON on one line, with a space
 * after each `,` and `:` between items, and nothing else added.
 */
function stringifyValue(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stringifyValue).join(', ')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}: ${stringifyValue(item)}`)
			.join(', ')}}`;
	return JSON.stringify(value);
}

/** Whether two JSON values are the same value: numbers by value, objects whatever their key order. */
function sameValue(a: JsonValue, b: JsonValue): boolean {
	if (a === b) return true;
	if (
		typeof a !== 'object' ||
		typeof b !== 'object' ||
		a === null ||
		b === null
	)
		return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		return a.every((item, index) => sameValue(item, b[index] as JsonValue));
	}
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(
		(key) =>
			Object.hasOwn(b, key) &&
			sameValue(a[key] as JsonValue, b[key] as JsonValue),
	);
}

export type FieldValues = Record<string, JsonValue>;

/**
 * A file's fields and body as read, each line whose text is not JSON (its
 * key, its line number in the file, and its text), and whether its front
 * matter could be read, so may be rewritten.
 */
type Read = {
	fields: FieldValues;
	notJson: { key: string; line: number; text: string }[];
	body: string;
	readable: boolean;
};

/**
 * A Markdown file's fields: each `key: <text>` line whose text is JSON. A
 * line whose text is not JSON is in `notJson`, and its key is not a field. A
 * file that does not open with `---` has none, and its whole text is body;
 * one whose front matter cannot be read is not `readable`.
 */
export function readMarkdown(text: string): Read {
	const parts = split(text);
	if (typeof parts === 'string')
		return { fields: {}, notJson: [], body: text, readable: parts === 'none' };
	return {
		fields: Object.fromEntries(
			parts.fields.flatMap(({ key, value }) =>
				value === undefined ? [] : [[key, value]],
			),
		),
		notJson: parts.fields.flatMap(({ key, number, text, value }) =>
			value === undefined ? [{ key, line: number, text }] : [],
		),
		body: parts.body,
		readable: true,
	};
}

/** A Markdown file of `fields` as `key: <JSON>` lines, then `body`. */
export function markdownOf(fields: FieldValues, body: string): string {
	const lines = Object.entries(fields).map(
		([key, value]) => `${key}: ${stringifyValue(value)}\n`,
	);
	return `---\n${lines.join('')}---\n${body}`;
}

/**
 * `text` with `given` set and `removed` gone. It replaces the line of each
 * key it sets (kept as typed when the value is already that), adds each new
 * key before the closing fence in the order given, and removes the line of
 * each key removed; a key in both is set. Every other line stays byte for
 * byte. A file with no front matter gets it before its text. Front matter
 * that cannot be read is never rewritten, so it throws.
 */
export function withFields(
	text: string,
	given: FieldValues,
	removed: readonly string[],
): string {
	for (const key of [...Object.keys(given), ...removed])
		if (!KEY.test(key)) throw new TypeError(`'${key}' cannot name a field`);
	const parts = split(text);
	if (parts === 'none') return markdownOf(given, text);
	if (parts === 'unreadable')
		throw new TypeError('Front matter that cannot be read is not rewritten');
	const eol = parts.open.endsWith('\r\n') ? '\r\n' : '\n';
	const gone = new Set(removed.filter((key) => !Object.hasOwn(given, key)));
	const lines: string[] = [];
	const present = new Set<string>();
	for (const field of parts.fields) {
		present.add(field.key);
		if (gone.has(field.key)) continue;
		const next = Object.hasOwn(given, field.key)
			? (given[field.key] as JsonValue)
			: undefined;
		if (
			next === undefined ||
			(field.value !== undefined && sameValue(field.value, next))
		) {
			lines.push(field.line);
			continue;
		}
		const ending = field.line.endsWith('\r\n') ? '\r\n' : '\n';
		lines.push(`${field.key}: ${stringifyValue(next)}${ending}`);
	}
	for (const [key, value] of Object.entries(given))
		if (!present.has(key)) lines.push(`${key}: ${stringifyValue(value)}${eol}`);
	return parts.open + lines.join('') + parts.close + parts.body;
}
