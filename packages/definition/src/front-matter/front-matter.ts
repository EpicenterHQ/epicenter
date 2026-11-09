/**
 * The front-matter primitive (ADR-0796, ADR-0797): read a note's fields,
 * patch one field's line, and merge two versions of a note by key.
 *
 * A file has front matter when its first line is `---`, a later line is
 * `---`, and every line between them is `key: <JSON>`, each key once. A
 * key is a letter or `_`, then letters, digits, `_` or `-`; a value is a
 * JSON text on that one line, which YAML 1.2 reads as the same value. A
 * line ends at `\n`, and a `\r` before it belongs to the ending. Anything
 * else is outside the grammar: the whole file is body. No YAML library is
 * involved.
 *
 * `fixtures/front-matter.json` holds every case, inputs and exact output
 * bytes, for this module and a Rust twin.
 */
import type { JsonValue } from '../json.js';
import { mergeLines } from './line-merge.js';

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

/** Which side of a merge wrote later, and wins a field both sides changed. */
export type Later = 'current' | 'incoming';

/** A merged note: its text (null when it ends deleted) and whether its body holds a conflict. */
export type Merged = { text: string | null; conflict: boolean };

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

/**
 * Merge `current` and `incoming`, both descended from `base` (null: no
 * file; a null base is two creates, a null side a delete), as ADR-0795
 * merges a note:
 *
 * - An edit beats a delete; a side that did not change takes the other.
 * - When all three are in the grammar (a null base counts as one with no
 *   fields and an empty body), fields merge by key, comparing values as
 *   JSON: a field one side changed takes that side's line, one both changed
 *   takes the `later` side's, a change beats a delete. Fields stay in the
 *   base's order; fields one side added follow, current's then incoming's,
 *   then fields both added, in name order. The body merges by lines.
 * - Otherwise the whole text merges by lines.
 *
 * A line merge's clash is written as Git's conflict block, `current` and
 * `incoming` its labels.
 */
export function merge3(
	base: string | null,
	current: string | null,
	incoming: string | null,
	{ later }: { later: Later },
): Merged {
	const clean = (text: string | null): Merged => ({ text, conflict: false });
	if (current === incoming) return clean(current);
	if (base !== null && current === base) return clean(incoming);
	if (base !== null && incoming === base) return clean(current);
	// One side is gone and the other changed or created it: the edit stands.
	if (current === null || incoming === null) return clean(current ?? incoming);

	const b =
		base === null ? { open: '', fields: [], close: '', body: '' } : split(base);
	const c = split(current);
	const i = split(incoming);
	if (b === null || c === null || i === null)
		return mergeLines(base ?? '', current, incoming);

	const byKey = (parts: Parts) =>
		new Map(parts.fields.map((field) => [field.key, field]));
	const [bk, ck, ik] = [byKey(b), byKey(c), byKey(i)];
	const pick = (key: string): Field | undefined => {
		const was = bk.get(key);
		const mine = ck.get(key);
		const theirs = ik.get(key);
		const changed = (field: Field | undefined) =>
			field !== undefined &&
			(was === undefined || !sameValue(field.value, was.value));
		if (mine && theirs) {
			const cChanged = changed(mine);
			const iChanged = changed(theirs);
			if (cChanged !== iChanged) return cChanged ? mine : theirs;
			return later === 'current' ? mine : theirs;
		}
		if (mine) return changed(mine) ? mine : undefined;
		if (theirs) return changed(theirs) ? theirs : undefined;
		return undefined;
	};

	const keys = [
		...b.fields.map(({ key }) => key),
		...c.fields
			.map(({ key }) => key)
			.filter((key) => !bk.has(key) && !ik.has(key)),
		...i.fields
			.map(({ key }) => key)
			.filter((key) => !bk.has(key) && !ck.has(key)),
		...c.fields
			.map(({ key }) => key)
			.filter((key) => !bk.has(key) && ik.has(key))
			.sort(),
	];
	const lines = keys.flatMap((key) => {
		const field = pick(key);
		return field === undefined ? [] : [field.line];
	});
	const body = mergeLines(b.body, c.body, i.body);
	const close =
		body.text !== '' && !c.close.endsWith('\n')
			? `${c.close}${c.open.slice(3)}`
			: c.close;
	return {
		text: c.open + lines.join('') + close + body.text,
		conflict: body.conflict,
	};
}
