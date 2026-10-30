/**
 * The Markdown codec: split a file into frontmatter and body, parse the
 * frontmatter with `yaml`, and change fields by editing the YAML text in place
 * so untouched keys, their order, quoting and comments stay as their writer
 * left them. Also the Git LFS pointer format, which is how a blob's file reads.
 *
 * A note is always valid: a text that does not open with parseable
 * frontmatter (a YAML mapping between `---` fences) is a note with no fields,
 * and its whole text is the body.
 */
import { type Document, isMap, isScalar, parseDocument, stringify } from 'yaml';

/** Values are written out in full: an alias would break when its anchor's key is removed. */
const PLAIN = { aliasDuplicateObjects: false } as const;

const OPEN = '---\n';
const CLOSE = '\n---\n';

/**
 * Where the `---` fences are, by syntax alone: the text starts with a `---`
 * line and a later line is exactly `---`. The door bounds the cost of
 * parsing this span before it is parsed; whether it is frontmatter is
 * `parseMarkdown`'s question.
 */
export function splitMarkdown(text: string) {
	if (!text.startsWith(OPEN)) return { yaml: null, yamlStart: 0, bodyStart: 0 };
	const close = `${text}\n`.indexOf(CLOSE, OPEN.length - 1);
	if (close < 0) return { yaml: null, yamlStart: 0, bodyStart: 0 };
	const yamlEnd = close + 1;
	return {
		yaml: text.slice(OPEN.length, Math.max(OPEN.length, yamlEnd)),
		yamlStart: OPEN.length,
		bodyStart: Math.min(text.length, close + CLOSE.length),
	};
}

/**
 * The body as SQL over a row's `text` and `fields`, where `fields` is
 * non-null exactly when the text has frontmatter (the replica's
 * `fieldsOf`): the same body `bodyOf` reads.
 */
export const BODY_SQL = `CASE WHEN fields IS NOT NULL AND substr(text, 1, 4) = '---' || char(10) AND instr(substr(text || char(10), 4), char(10) || '---' || char(10)) > 0 THEN substr(text, instr(substr(text || char(10), 4), char(10) || '---' || char(10)) + 8) ELSE text END`;

export type ParsedMarkdown = {
	fields: Record<string, unknown>;
	body: string;
	hasFrontmatter: boolean;
};

/** A text's frontmatter, parsed: null when it does not open with a YAML mapping between fences. */
function frontmatter(text: string) {
	const parts = splitMarkdown(text);
	if (parts.yaml === null) return null;
	const read = readYaml(parts.yaml);
	return read === null ? null : { yaml: parts.yaml, bodyStart: parts.bodyStart, ...read };
}

/** A note's fields and body: with no parseable frontmatter, no fields and the whole text. */
export function parseMarkdown(text: string): ParsedMarkdown {
	const front = frontmatter(text);
	if (front === null) return { fields: {}, body: text, hasFrontmatter: false };
	return { fields: front.fields, body: text.slice(front.bodyStart), hasFrontmatter: true };
}

/** The frontmatter YAML read as a mapping (an empty one has no fields), or null when it is not one. */
function readYaml(yaml: string) {
	const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0) return null;
	const contents = document.contents;
	if (contents === null || (isScalar(contents) && contents.value === null))
		return { document, fields: {} as Record<string, unknown> };
	if (!isMap(contents)) return null;
	try {
		return { document, fields: document.toJS() as Record<string, unknown> };
	} catch {
		// An alias with no anchor, or more aliases than `yaml` expands: a mapping that has no fields to read.
		return null;
	}
}

export type MarkdownChange = {
	/** Keys to set; a key set to `undefined` is removed. */
	fields?: Record<string, unknown>;
	body?: string;
};

/**
 * Apply a change to a file's text (null for a new file). Only keys whose value
 * changes are rewritten; new keys are appended after the existing ones. A
 * text with no parseable frontmatter gains a header before its whole text.
 */
export function writeMarkdown(previous: string | null, change: MarkdownChange): string {
	const source = previous ?? '';
	const front = frontmatter(source);
	const body = change.body ?? source.slice(front?.bodyStart ?? 0);
	const changes = Object.entries(change.fields ?? {});

	if (front === null) {
		const added = changes.filter(([, value]) => value !== undefined);
		if (added.length === 0) return guardBody('', body);
		return `${OPEN}${stringify(Object.fromEntries(added), PLAIN)}---\n${body}`;
	}

	const { document, fields } = front;
	const pending = changes.filter(([key, value]) =>
		value === undefined ? Object.hasOwn(fields, key) : !sameValue(fields[key], value),
	);
	let yaml = front.yaml;
	if (pending.length > 0) {
		const expected = { ...fields };
		for (const [key, value] of pending) {
			if (value === undefined) delete expected[key];
			else expected[key] = value;
		}
		const reads = (candidate: string | null) => candidate !== null && sameValue(readYaml(candidate)?.fields, expected);
		const spliced = spliceYaml(front.yaml, document, pending);
		if (reads(spliced)) yaml = spliced as string;
		else {
			const rewritten = rewriteYaml(document, pending);
			// A document whose aliases the change broke is written as its fields alone.
			yaml = reads(rewritten) ? (rewritten as string) : Object.keys(expected).length === 0 ? '' : stringify(expected, PLAIN);
		}
	}
	// A closing fence at the very end with no newline stays that way.
	const isBareClose = front.bodyStart === source.length && !source.endsWith('\n');
	if (isBareClose && body === '') return `${OPEN}${yaml}---`;
	return `${OPEN}${yaml}---\n${body}`;
}

/** A text's body: what follows its frontmatter, or the whole text when it has none. */
export const bodyOf = (text: string) => text.slice(frontmatter(text)?.bodyStart ?? 0);

/** A text's frontmatter with its fences, byte for byte: empty when it has none. */
export const headerOf = (text: string) => text.slice(0, frontmatter(text)?.bodyStart ?? 0);

/**
 * `text` with its body replaced by `body`, its frontmatter kept byte for
 * byte, so an editor's body never touches a field.
 */
export function withBody(text: string, body: string) {
	const header = headerOf(text);
	// A closing fence at the very end has no newline after it yet.
	if (header !== '' && !header.endsWith('\n') && body !== '') return `${header}\n${body}`;
	return guardBody(header, body);
}

/** A body after an empty header must not itself read as frontmatter. */
function guardBody(header: string, body: string) {
	return header === '' && frontmatter(body) !== null ? `${OPEN}---\n${body}` : header + body;
}

/**
 * Change the YAML text by replacing only the changed pairs' source spans.
 * Returns null when a pair's span cannot be located; the caller then verifies
 * the result reads back as expected and otherwise falls back to `rewriteYaml`.
 */
function spliceYaml(
	yaml: string,
	document: Document,
	changes: [string, unknown][],
): string | null {
	const contents = document.contents;
	const items = isMap(contents) ? contents.items : [];
	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	let appended = '';
	for (const [key, value] of changes) {
		const pair = items.find((item) => isScalar(item.key) && String(item.key.value) === key);
		const rendered = stringify({ [key]: value }, PLAIN);
		if (pair === undefined) {
			if (value !== undefined) appended += rendered;
			continue;
		}
		const keyRange = isScalar(pair.key) ? pair.key.range : undefined;
		const valueRange =
			pair.value !== null && typeof pair.value === 'object' && 'range' in pair.value
				? (pair.value.range as [number, number, number] | undefined)
				: undefined;
		const start = keyRange?.[0];
		const end = valueRange?.[1] ?? keyRange?.[1];
		if (start === undefined || end === undefined) return null;
		const endsLine = yaml[end - 1] === '\n';
		if (value === undefined) {
			const lineStart = yaml.lastIndexOf('\n', start - 1) + 1;
			const next = yaml.indexOf('\n', endsLine ? end - 1 : end);
			edits.push({ start: lineStart, end: next < 0 ? yaml.length : next + 1, text: '' });
			continue;
		}
		edits.push({ start, end, text: endsLine ? rendered : rendered.replace(/\n$/, '') });
	}
	let out = yaml;
	for (const edit of edits.sort((a, b) => b.start - a.start))
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	if (appended !== '') out = (out === '' || out.endsWith('\n') ? out : `${out}\n`) + appended;
	return out;
}

/** The fallback: change the parsed document and print it whole; null when it cannot be printed (an alias whose anchor went). */
function rewriteYaml(document: Document, changes: [string, unknown][]) {
	for (const [key, value] of changes) {
		if (value === undefined) document.delete(key);
		else document.set(key, value);
	}
	try {
		const printed = document.toString();
		return printed === '{}\n' || printed === 'null\n' ? '' : printed;
	} catch {
		return null;
	}
}

/** Deep equality over plain JSON-like values. */
export function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every(
		(key) =>
			Object.hasOwn(b, key) &&
			sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
	);
}

// ============================================================================
// Git LFS pointers
// ============================================================================

export type LfsPointer = { oid: string; size: number };

const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The pointer a file's text holds, or null when the text is not a pointer. */
export function parsePointer(text: string): LfsPointer | null {
	const found = POINTER.exec(text);
	if (found === null) return null;
	const [, oid = '', size = ''] = found;
	return { oid, size: Number(size) };
}

export function writePointer({ oid, size }: LfsPointer): string {
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}
