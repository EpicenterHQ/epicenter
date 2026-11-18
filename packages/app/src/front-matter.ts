/**
 * A data file as fields and body (ADR-0796, ADR-0924). The grammar
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
 * A write writes the line of each key it names, adds a new key before the
 * closing fence, and removes a deleted key's line. Every other line stays
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

export type FieldValues = Record<string, JsonValue>;

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** A front matter line: a key, then `:`, then nothing or a space and its text. */
const LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/s;

/** Whether `key` can name a field line. */
export const isFieldKey = (key: string) => KEY.test(key);

/** One `key: <text>` line as the file holds it, and its value when its text is JSON. */
type Field = {
	key: string;
	line: string;
	lineNumber: number;
	text: string;
	value: JsonValue | undefined;
};

/**
 * A file split at its fences, each piece verbatim. A file that does not open
 * with `---` splits as empty fences before its whole text, so a write gives
 * it front matter the same way it changes front matter that is there.
 */
type Parts = { open: string; fields: Field[]; close: string; body: string };

/** The line ending `line` ends with. */
const endingOf = (line: string) => (line.endsWith('\r\n') ? '\r\n' : '\n');

/** `text` as JSON, or undefined when it is not JSON. */
function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/** The file's pieces, or `'unreadable'` when its front matter cannot be read. */
function split(text: string): Parts | 'unreadable' {
	const ending = (from: number) => {
		const lf = text.indexOf('\n', from);
		return lf < 0 ? text.length : lf + 1;
	};
	const content = (line: string) => line.replace(/\r?\n$/, '');
	const openEnd = ending(0);
	const open = text.slice(0, openEnd);
	if (content(open) !== '---' || !open.endsWith('\n'))
		return { open: '---\n', fields: [], close: '---\n', body: text };
	const fields: Field[] = [];
	let lineNumber = 1;
	for (let at = openEnd; at < text.length; ) {
		lineNumber++;
		const end = ending(at);
		const line = text.slice(at, end);
		const raw = content(line);
		if (raw === '---')
			return { open, fields, close: line, body: text.slice(end) };
		const match = LINE.exec(raw);
		if (!match || !line.endsWith('\n')) return 'unreadable';
		const [, key = '', rest = ''] = match;
		if (fields.some((field) => field.key === key)) return 'unreadable';
		fields.push({ key, line, lineNumber, text: rest, value: parseJson(rest) });
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

/** A key whose line is `key: <text>` and whose text is not JSON. */
export type NotJson = { key: string; lineNumber: number; text: string };

/**
 * A Markdown file as read: its fields, each line whose text is not JSON, its
 * body, and whether its front matter could be read, so may be rewritten. A
 * file whose front matter cannot be read has no fields, and its whole text
 * is body.
 */
export type MarkdownFile = {
	fields: FieldValues;
	notJson: NotJson[];
	body: string;
	readable: boolean;
};

/**
 * A Markdown file's fields: each `key: <text>` line whose text is JSON. A
 * line whose text is not JSON is in `notJson`, and its key is not a field.
 */
export function readMarkdown(text: string): MarkdownFile {
	const parts = split(text);
	if (parts === 'unreadable')
		return { fields: {}, notJson: [], body: text, readable: false };
	const fields: FieldValues = {};
	const notJson: NotJson[] = [];
	for (const { key, lineNumber, text, value } of parts.fields)
		if (value === undefined) notJson.push({ key, lineNumber, text });
		else fields[key] = value;
	return { fields, notJson, body: parts.body, readable: true };
}

/** What a write changes: the fields it sets, the keys it removes, and the body that replaces the file's. */
export type MarkdownChange = {
	set: FieldValues;
	removed?: readonly string[];
	body?: string;
};

/**
 * `text` with `change` made. Each key set gets its line written, in place
 * when the file has it and before the closing fence when it does not; each
 * key removed loses its line, and a key both set and removed is set. Every
 * other line stays byte for byte, and so does the body unless the change
 * gives one. Every key must pass `isFieldKey`, as a declared field does.
 * Front matter that cannot be read is never rewritten, so it throws.
 */
export function changeMarkdown(
	text: string,
	{ set, removed = [], body }: MarkdownChange,
): string {
	const parts = split(text);
	if (parts === 'unreadable')
		throw new TypeError('Front matter that cannot be read is not rewritten');
	const lineOf = (key: string, ending: string) =>
		`${key}: ${stringifyValue(set[key] as JsonValue)}${ending}`;
	const present = new Set(parts.fields.map((field) => field.key));
	const lines = [
		...parts.fields.flatMap(({ key, line }) => {
			if (Object.hasOwn(set, key)) return [lineOf(key, endingOf(line))];
			return removed.includes(key) ? [] : [line];
		}),
		...Object.keys(set)
			.filter((key) => !present.has(key))
			.map((key) => lineOf(key, endingOf(parts.open))),
	];
	return parts.open + lines.join('') + parts.close + (body ?? parts.body);
}
