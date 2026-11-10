/**
 * A note's front matter (ADR-0796, ADR-0797): read its fields and patch one
 * field's line, copied from the waiting product's front matter without its
 * merge (ADR-0843: new code copies from it, never imports it).
 *
 * A file has front matter when its first line is `---`, a later line is
 * `---`, and every line between them is `key: <JSON>`, each key once. A
 * key is a letter or `_`, then letters, digits, `_` or `-`; a value is a
 * JSON text on that one line, which YAML 1.2 reads as the same value. A
 * line ends at `\n`, and a `\r` before it belongs to the ending. Anything
 * else is outside the grammar: the whole file is body. No YAML library is
 * involved.
 *
 */
/** A JSON value. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

/** A note in the grammar: its fields in file order, and the text after the closing fence. */
export type FrontMatter = {
	fields: Record<string, JsonValue>;
	body: string;
};

/** The change a patch applies: fields to set, and keys to delete. A key in both is set. */
export type FieldPatch = {
	set?: Record<string, JsonValue>;
	delete?: readonly string[];
};

const KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Whether `key` can name a field line. */
export const isFieldKey = (key: string) => KEY.test(key);

/** One field line as the file holds it. */
type Field = { key: string; value: JsonValue; line: string };

/** A note split at its fences, each piece verbatim. */
type Parts = { open: string; fields: Field[]; close: string; body: string };

/** The note's pieces, or null when it is outside the grammar. */
function split(text: string): Parts | null {
	const ending = (from: number) => {
		const lf = text.indexOf('\n', from);
		return lf < 0 ? text.length : lf + 1;
	};
	const content = (line: string) => line.replace(/\r?\n$/, '');
	const openEnd = ending(0);
	const open = text.slice(0, openEnd);
	if (content(open) !== '---' || !open.endsWith('\n')) return null;
	const fields: Field[] = [];
	const seen = new Set<string>();
	for (let at = openEnd; at < text.length; ) {
		const end = ending(at);
		const line = text.slice(at, end);
		const raw = content(line);
		if (raw === '---')
			return { open, fields, close: line, body: text.slice(end) };
		const colon = raw.indexOf(': ');
		if (colon < 0 || !line.endsWith('\n')) return null;
		const key = raw.slice(0, colon);
		if (!KEY.test(key) || seen.has(key)) return null;
		let value: JsonValue;
		try {
			value = JSON.parse(raw.slice(colon + 2)) as JsonValue;
		} catch {
			return null;
		}
		seen.add(key);
		fields.push({ key, value, line });
		at = end;
	}
	return null;
}

/** The note's fields and body, or null when it has no front matter: then all of it is body. */
export function parseFrontMatter(text: string): FrontMatter | null {
	const parts = split(text);
	if (parts === null) return null;
	return {
		fields: Object.fromEntries(
			parts.fields.map(({ key, value }) => [key, value]),
		),
		body: parts.body,
	};
}

/**
 * A field's value as Epicenter writes it: JSON on one line, with a space
 * after each `,` and `:` between items, and nothing else added.
 */
export function stringifyValue(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stringifyValue).join(', ')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}: ${stringifyValue(item)}`)
			.join(', ')}}`;
	return JSON.stringify(value);
}

/** Whether two JSON values are the same value: numbers by value, objects whatever their key order. */
export function sameValue(a: JsonValue, b: JsonValue): boolean {
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

/**
 * Apply `patch` to the note `text` as it is: replace the line of each field
 * it sets (kept as typed when the value is already that), add each new one
 * before the closing fence in the order given, and remove the line of each
 * field it deletes. Every other line stays byte for byte. `'outside'` when
 * the note is outside the grammar, and nothing is changed: a patch never
 * normalizes. It takes text, so it never creates a file.
 */
export function patchFrontMatter(
	text: string,
	{ set = {}, delete: deleted = [] }: FieldPatch,
): string | 'outside' {
	for (const key of [...Object.keys(set), ...deleted])
		if (!KEY.test(key)) throw new TypeError(`'${key}' cannot name a field`);
	const parts = split(text);
	if (parts === null) return 'outside';
	const eol = parts.open.endsWith('\r\n') ? '\r\n' : '\n';
	const gone = new Set(deleted.filter((key) => !Object.hasOwn(set, key)));
	const lines: string[] = [];
	const present = new Set<string>();
	for (const field of parts.fields) {
		present.add(field.key);
		if (gone.has(field.key)) continue;
		if (
			!Object.hasOwn(set, field.key) ||
			sameValue(field.value, set[field.key] as JsonValue)
		) {
			lines.push(field.line);
			continue;
		}
		const ending = field.line.endsWith('\r\n') ? '\r\n' : '\n';
		lines.push(
			`${field.key}: ${stringifyValue(set[field.key] as JsonValue)}${ending}`,
		);
	}
	for (const [key, value] of Object.entries(set))
		if (!present.has(key)) lines.push(`${key}: ${stringifyValue(value)}${eol}`);
	return parts.open + lines.join('') + parts.close + parts.body;
}
