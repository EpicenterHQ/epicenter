/**
 * The Markdown codec: split a file into frontmatter and body, parse the
 * frontmatter with `yaml`, and change fields by editing the YAML text in place
 * so untouched keys, their order, quoting and comments stay as their writer
 * left them. Also the Git LFS pointer format, which is how a blob's file reads.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { type Document, isMap, isScalar, parseDocument, stringify } from 'yaml';

export const MarkdownError = defineErrors({
	/** The frontmatter is not YAML, or not a mapping. `line` is the file's line, from 1, where it goes wrong. */
	Unparseable: ({ reason, line }: { reason: string; line: number }) => ({
		message: `The frontmatter does not parse (line ${line}): ${reason}`,
		reason,
		line,
	}),
});
export type MarkdownError = InferErrors<typeof MarkdownError>;

const OPEN = '---\n';
const CLOSE = '\n---\n';

/**
 * Where the frontmatter and body are. Frontmatter exists when the text starts
 * with a `---` line and a later line is exactly `---`. This is the same rule as
 * `BODY_SQL`, so the body a view reads is the body this codec writes.
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

/** The body as a plain SQL expression over a `text` column; see `splitMarkdown`. */
export const BODY_SQL = `CASE WHEN substr(text, 1, 4) = '---' || char(10) AND instr(substr(text || char(10), 4), char(10) || '---' || char(10)) > 0 THEN substr(text, instr(substr(text || char(10), 4), char(10) || '---' || char(10)) + 8) ELSE text END`;

export type ParsedMarkdown = {
	fields: Record<string, unknown>;
	body: string;
	hasFrontmatter: boolean;
};

export function parseMarkdown(text: string): Result<ParsedMarkdown, MarkdownError> {
	const parts = splitMarkdown(text);
	const body = text.slice(parts.bodyStart);
	if (parts.yaml === null) return Ok({ fields: {}, body, hasFrontmatter: false });
	const document = readYaml(parts.yaml);
	if (document.error !== null) return document;
	return Ok({ fields: document.data.fields, body, hasFrontmatter: true });
}

/** Whether a text's frontmatter parses: a file without frontmatter does. */
export const parses = (text: string) => parseMarkdown(text).error === null;

/** The frontmatter YAML read as a mapping. Error lines count from the file's first line, the opening fence. */
function readYaml(yaml: string) {
	const document = parseDocument(yaml, { prettyErrors: false, uniqueKeys: true });
	const lineAt = (offset: number) => 2 + (yaml.slice(0, offset).match(/\n/g)?.length ?? 0);
	const [first] = document.errors;
	if (first !== undefined) return MarkdownError.Unparseable({ reason: first.message, line: lineAt(first.pos[0]) });
	const contents = document.contents;
	if (contents === null || (isScalar(contents) && contents.value === null))
		return Ok({ document, fields: {} as Record<string, unknown> });
	if (!isMap(contents))
		return MarkdownError.Unparseable({ reason: 'the frontmatter is not a mapping', line: lineAt(contents.range?.[0] ?? 0) });
	const fields = document.toJS() as Record<string, unknown>;
	return Ok({ document, fields });
}

export type MarkdownChange = {
	/** Keys to set; a key set to `undefined` is removed. */
	fields?: Record<string, unknown>;
	body?: string;
};

/**
 * Apply a change to a file's text (null for a new file). Only keys whose value
 * changes are rewritten; new keys are appended after the existing ones.
 */
export function writeMarkdown(
	previous: string | null,
	change: MarkdownChange,
): Result<string, MarkdownError> {
	const source = previous ?? '';
	const parts = splitMarkdown(source);
	const body = change.body ?? source.slice(parts.bodyStart);
	const changes = Object.entries(change.fields ?? {});

	if (parts.yaml === null) {
		const added = changes.filter(([, value]) => value !== undefined);
		if (added.length === 0) return Ok(guardBody('', body));
		return Ok(`${OPEN}${stringify(Object.fromEntries(added))}---\n${body}`);
	}

	const read = readYaml(parts.yaml);
	if (read.error !== null) return read;
	const { document, fields } = read.data;
	const pending = changes.filter(([key, value]) =>
		value === undefined ? Object.hasOwn(fields, key) : !sameValue(fields[key], value),
	);
	let yaml = parts.yaml;
	if (pending.length > 0) {
		const expected = { ...fields };
		for (const [key, value] of pending) {
			if (value === undefined) delete expected[key];
			else expected[key] = value;
		}
		const spliced = spliceYaml(parts.yaml, document, pending);
		yaml =
			spliced !== null && sameValue(readYaml(spliced).data?.fields, expected)
				? spliced
				: rewriteYaml(document, pending);
	}
	// A closing fence at the very end with no newline stays that way.
	const isBareClose = parts.bodyStart === source.length && !source.endsWith('\n');
	if (isBareClose && body === '') return Ok(`${OPEN}${yaml}---`);
	return Ok(`${OPEN}${yaml}---\n${body}`);
}

/** A body after an empty header must not itself read as frontmatter. */
function guardBody(header: string, body: string) {
	return header === '' && splitMarkdown(body).yaml !== null ? `${OPEN}---\n${body}` : header + body;
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
		const rendered = stringify({ [key]: value });
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

/** The fallback: change the parsed document and print it whole. */
function rewriteYaml(document: Document, changes: [string, unknown][]) {
	for (const [key, value] of changes) {
		if (value === undefined) document.delete(key);
		else document.set(key, value);
	}
	const printed = document.toString();
	return printed === '{}\n' || printed === 'null\n' ? '' : printed;
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

/** Notes larger than this, stored, are refused. */
export const MAX_NOTE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/** Whether a text is a note: a Markdown file that is not an LFS pointer. */
const isNote = (path: string, text: string) => path.endsWith('.md') && parsePointer(text) === null;

/**
 * Whether writing `text` over `previous` (null for no file) would turn a
 * note whose frontmatter parses into one whose frontmatter does not. That is
 * the one parse rule: a note that does not parse may take any text, so
 * repairing it can save every step, and a new note breaks nothing.
 */
export function breaksParsing(path: string, previous: string | null, text: string | null) {
	if (previous === null || text === null || !isNote(path, text)) return false;
	return parses(previous) && !parses(text);
}

/**
 * Whether a device may send `text` over `below`, what the server will have
 * at `path` once the device's queued changes land (null for no file): the
 * text parses, or what is below exists and does not parse either. A text
 * that fails it stays on the device, held, until it parses or what is below
 * stops parsing. It is stricter than `breaksParsing`, which a server
 * applies: a device never creates a note that does not parse, so a remote
 * delete under held text keeps it held.
 */
export function passesParseGate(path: string, below: string | null, text: string | null) {
	if (text === null || !isNote(path, text)) return true;
	return parses(text) || (below !== null && isNote(path, below) && !parses(below));
}

/**
 * Why a file's text cannot be stored in the repository over `previous`, the
 * text it replaces (null for no file), or null when it can: binary text
 * belongs in Git LFS, a note is at most 1 MB, and a write never breaks a
 * note's frontmatter that parses (`breaksParsing`). A push is refused for
 * these, the server keeps the current text of a note a batch would break,
 * and a device checks them before a write resolves, so a person's write
 * never fails later for a reason it could have been told at once.
 */
export function storageRefusal(
	path: string,
	previous: string | null,
	text: string,
): { kind: 'binary' | 'size' | 'parse'; reason: string } | null {
	if (text.includes('\0')) return { kind: 'binary', reason: 'a binary file must be stored through Git LFS' };
	if (!isNote(path, text)) return null;
	if (encoder.encode(text).length > MAX_NOTE_BYTES) return { kind: 'size', reason: 'a note may be at most 1 MB' };
	if (!breaksParsing(path, previous, text)) return null;
	const { error } = parseMarkdown(text);
	return { kind: 'parse', reason: error === null ? 'it does not parse' : `${error.reason} (line ${error.line})` };
}
