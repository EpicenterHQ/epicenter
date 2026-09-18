/**
 * The frontmatter half of a row's export file (ADR-0268).
 *
 * One block of YAML above the body, carrying the row's raw stored fields. The
 * emitter is deliberately a subset of YAML chosen for exact round-trips:
 * every string is emitted as a JSON string (a valid YAML double-quoted
 * vocab-check: ignore-next-line (YAML's word for a plain node)
 * scalar), numbers, booleans, and null emit bare, and compound values emit as
 * JSON (valid YAML flow style). Nothing bare can ever be re-read as another
 * type, so `"007"` and `"no"` survive as the strings they are; the artifact
 * is lossy of history, never of a value (ADR-0267/0268).
 *
 * Keys are sorted, so two exports of one store diff line by line. A key
 * outside the declared field grammar (a value an older release wrote) is
 * emitted as a JSON-quoted key, which YAML also accepts.
 *
 * Reading is the same subset, plus one concession to the person the artifact
 * exists for: a value this emitter would have quoted and a hand editor did
 * not is read as the string it looks like. That can only ever produce a
 * string, so a hand edit cannot change a value's type by accident; what it
 * cannot rescue is a hand-typed `007`, which reads as the number YAML has
 * always read it as.
 */
import type { JsonObject, JsonValue } from '../definition/index.js';

/** A key YAML takes unquoted without reinterpretation: the field grammar. */
const BARE_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * One row's fields as a frontmatter block, `---` through `---`.
 *
 * Always present, even empty, so a file's body begins at one deterministic
 * place: after the closing delimiter and one blank separator line.
 */
export function frontmatter(fields: JsonObject): string {
	const lines = ['---'];
	for (const key of Object.keys(fields).sort()) {
		const name = BARE_KEY.test(key) ? key : JSON.stringify(key);
		lines.push(`${name}: ${yamlValue(fields[key])}`);
	}
	lines.push('---');
	return lines.join('\n');
}

function yamlValue(value: JsonValue | undefined): string {
	if (value === undefined || value === null) return 'null';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	// Arrays and objects: JSON is valid YAML flow style, and exact.
	return JSON.stringify(value);
}

/**
 * One row's whole export file: frontmatter, and the body when there is one.
 *
 * A blank line separates the block from the body for legibility; a row with
 * no body (a table without a document block, or a codec that serialized the
 * empty document to nothing) is the frontmatter block alone.
 */
export function rowFile(fields: JsonObject, body: string | undefined): string {
	const block = frontmatter(fields);
	if (body === undefined || body === '') return `${block}\n`;
	return `${block}\n\n${body}\n`;
}

/** One row file read back: the frontmatter fields, and the body beneath them. */
export type ParsedRowFile = { fields: JsonObject; body: string };

/**
 * Read one row file back into its fields and its body.
 *
 * Strict about the frame and forgiving about the values. A file must open with
 * `---` and close the block with `---`, because the frame is what makes a body
 * containing `---` unambiguous; `undefined` says this text is not a row file at
 * all, which is the caller's cue to refuse rather than to guess.
 */
export function parseRowFile(text: string): ParsedRowFile | undefined {
	const lines = text.split('\n');
	if (lines[0]?.trimEnd() !== '---') return undefined;
	const close = lines.findIndex(
		(line, index) => index > 0 && line.trimEnd() === '---',
	);
	if (close === -1) return undefined;

	const fields: JsonObject = {};
	for (const line of lines.slice(1, close)) {
		if (line.trim() === '') continue;
		const entry = parseEntry(line);
		if (entry !== undefined) fields[entry.key] = entry.value;
	}

	// One blank separator line is the emitter's, not the body's. Everything
	// after it is the body, minus the single trailing newline a file ends with.
	const rest = lines.slice(close + 1);
	if (rest[0] === '') rest.shift();
	if (rest.at(-1) === '') rest.pop();
	return { fields, body: rest.join('\n') };
}

function parseEntry(
	line: string,
): { key: string; value: JsonValue } | undefined {
	const { key, rest } = splitKey(line);
	if (key === undefined) return undefined;
	return { key, value: parseValue(rest.trim()) };
}

/** The key up to its colon, quoted or bare, and whatever follows it. */
function splitKey(line: string): { key?: string; rest: string } {
	if (!line.startsWith('"')) {
		const colon = line.indexOf(':');
		if (colon === -1) return { rest: line };
		return { key: line.slice(0, colon).trim(), rest: line.slice(colon + 1) };
	}
	// A JSON-quoted key may hold a colon, so the closing quote is found by
	// scanning past escapes rather than by searching for the delimiter.
	let index = 1;
	while (index < line.length) {
		if (line[index] === '\\') index += 2;
		else if (line[index] === '"') break;
		else index += 1;
	}
	if (index >= line.length) return { rest: line };
	const quoted = line.slice(0, index + 1);
	const after = line.slice(index + 1);
	if (!after.startsWith(':')) return { rest: line };
	try {
		return { key: JSON.parse(quoted) as string, rest: after.slice(1) };
	} catch {
		return { rest: line };
	}
}

/**
 * One emitted value, read back exactly, or the bare text a person typed.
 *
 * Everything this module writes is JSON, so `JSON.parse` is the exact inverse.
 * What it refuses is a hand edit, and the fallback is the raw text as a
 * string: the one reading that cannot silently retype a value.
 */
function parseValue(raw: string): JsonValue {
	if (raw === '') return '';
	try {
		return JSON.parse(raw) as JsonValue;
	} catch {
		return raw;
	}
}
