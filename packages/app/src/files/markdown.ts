/**
 * Markdown row source: frontmatter framing, interpretation, and
 * source-preserving patches.
 *
 * Patching never re-emits YAML. It locates the touched value's node range in
 * the parsed frontmatter and replaces only that span, or appends a new key
 * before the closing fence. Every other byte, including comments, quoting,
 * key order, a byte-order mark, and CRLF line endings, is preserved. The
 * patched frontmatter is parsed again; if any untouched value changed or a
 * touched value does not read back exactly, the patch is refused instead of
 * written.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	isAlias,
	isMap,
	isNode,
	isScalar,
	type Node,
	parseDocument,
	stringify,
} from 'yaml';

const BOM = '﻿';

/** The located parts of a row file's text. Offsets index into the source string. */
export type SourceFrame =
	| {
			readonly kind: 'none';
			readonly bom: string;
			readonly bodyStart: number;
			readonly newline: '\n' | '\r\n';
	  }
	| {
			readonly kind: 'frontmatter';
			readonly bom: string;
			/** Offset of the first byte of YAML, after the opening fence line. */
			readonly yamlStart: number;
			/** Offset of the closing fence line. */
			readonly yamlEnd: number;
			readonly bodyStart: number;
			readonly newline: '\n' | '\r\n';
	  }
	| { readonly kind: 'unclosed'; readonly bom: string };

/** Locate frontmatter. Only an exact `---` first line opens it; the next exact `---` line closes it. */
export function frameSource(source: string): SourceFrame {
	const bom = source.startsWith(BOM) ? BOM : '';
	const start = bom.length;
	const openingNewline = source.startsWith('---\r\n', start)
		? '\r\n'
		: source.startsWith('---\n', start)
			? '\n'
			: undefined;
	if (openingNewline === undefined) {
		if (source.slice(start) === '---') return { kind: 'unclosed', bom };
		const newline = source.includes('\r\n') ? '\r\n' : '\n';
		return { kind: 'none', bom, bodyStart: start, newline };
	}
	const yamlStart = start + 3 + openingNewline.length;
	let lineStart = yamlStart;
	while (lineStart <= source.length) {
		const lineFeed = source.indexOf('\n', lineStart);
		const lineEnd = lineFeed < 0 ? source.length : lineFeed;
		const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
		if (line === '---') {
			return {
				kind: 'frontmatter',
				bom,
				yamlStart,
				yamlEnd: lineStart,
				bodyStart: lineFeed < 0 ? source.length : lineFeed + 1,
				newline: openingNewline,
			};
		}
		if (lineFeed < 0) break;
		lineStart = lineFeed + 1;
	}
	return { kind: 'unclosed', bom };
}

export type SourceIssue = {
	readonly kind: 'frontmatter';
	readonly message: string;
};

/** Frontmatter values and body as read from source, without a schema. */
export type ReadSource = {
	readonly frame: SourceFrame;
	/** Frontmatter keys and values; undefined when the frontmatter cannot be read. */
	readonly values: Readonly<Record<string, unknown>> | undefined;
	/** Text after the frontmatter; undefined when the framing is ambiguous. */
	readonly body: string | undefined;
	readonly issues: readonly SourceIssue[];
};

function parseFrontmatter(yaml: string) {
	return parseDocument(yaml, {
		prettyErrors: false,
		uniqueKeys: true,
		version: '1.2',
	});
}

export function readSource(source: string): ReadSource {
	const frame = frameSource(source);
	if (frame.kind === 'unclosed')
		return {
			frame,
			values: undefined,
			body: undefined,
			issues: [
				{
					kind: 'frontmatter',
					message: 'The frontmatter opening line has no closing --- line',
				},
			],
		};
	const body = source.slice(frame.bodyStart);
	if (frame.kind === 'none') return { frame, values: {}, body, issues: [] };
	const document = parseFrontmatter(
		source.slice(frame.yamlStart, frame.yamlEnd),
	);
	if (document.errors.length > 0)
		return {
			frame,
			values: undefined,
			body,
			issues: document.errors.map((error) => ({
				kind: 'frontmatter' as const,
				message: `Invalid YAML: ${error.message}`,
			})),
		};
	if (document.contents === null)
		return { frame, values: {}, body, issues: [] };
	if (!isMap(document.contents))
		return {
			frame,
			values: undefined,
			body,
			issues: [
				{ kind: 'frontmatter', message: 'The frontmatter is not a mapping' },
			],
		};
	for (const pair of document.contents.items)
		if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
			return {
				frame,
				values: undefined,
				body,
				issues: [
					{ kind: 'frontmatter', message: 'A frontmatter key is not a string' },
				],
			};
	const converted = convertFrontmatter(document);
	if (converted.error)
		return {
			frame,
			values: undefined,
			body,
			issues: [{ kind: 'frontmatter', message: converted.error.reason }],
		};
	return { frame, values: converted.data, body, issues: [] };
}

/** Bounded alias expansion; larger expansions are refused, not evaluated. */
const MAX_ALIAS_COUNT = 100;

/**
 * Convert parsed frontmatter to plain values. Unresolvable aliases, excessive
 * alias expansion, and circular aliases become a refusal instead of a throw,
 * so the source stays readable and repairable.
 */
function convertFrontmatter(
	document: ReturnType<typeof parseFrontmatter>,
): Result<Record<string, unknown>, PatchRefusal> {
	if (document.contents === null) return Ok({});
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
	} catch (cause) {
		return Err({
			reason: `The frontmatter cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		});
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return Err({ reason: 'The frontmatter is not a mapping' });
	if (isCircular(value))
		return Err({ reason: 'The frontmatter contains a circular alias' });
	return Ok(value as Record<string, unknown>);
}

function isCircular(value: unknown, ancestors = new Set<object>()): boolean {
	if (typeof value !== 'object' || value === null) return false;
	if (ancestors.has(value)) return true;
	ancestors.add(value);
	for (const child of Object.values(value))
		if (isCircular(child, ancestors)) return true;
	ancestors.delete(value);
	return false;
}

export type PatchRefusal = { readonly reason: string };

export type SourceChange = {
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly body?: string;
};

/**
 * Apply field values and an optional replacement body to captured source,
 * preserving every unrelated byte. Returns the new source or a refusal; it
 * never guesses at ambiguous framing or invalid YAML.
 */
export function patchSource(
	source: string,
	change: SourceChange,
): Result<string, PatchRefusal> {
	const frame = frameSource(source);
	if (frame.kind === 'unclosed')
		return Err({ reason: 'the frontmatter has no closing --- line' });
	let head: string;
	if (frame.kind === 'none') {
		const created = frontmatterBlock(change.fields ?? {}, frame.newline);
		if (created.error) return created;
		head = frame.bom + created.data;
	} else {
		const yaml = source.slice(frame.yamlStart, frame.yamlEnd);
		const patched = patchYaml(yaml, change.fields ?? {}, frame.newline);
		if (patched.error) return patched;
		head =
			source.slice(0, frame.yamlStart) +
			patched.data +
			source.slice(frame.yamlEnd, frame.bodyStart);
	}
	const body = change.body ?? source.slice(frame.bodyStart);
	return Ok(head + body);
}

function patchYaml(
	yaml: string,
	fields: Readonly<Record<string, unknown>>,
	newline: '\n' | '\r\n',
): Result<string, PatchRefusal> {
	const entries = Object.entries(fields);
	if (entries.length === 0) return Ok(yaml);
	const document = parseFrontmatter(yaml);
	if (document.errors.length > 0)
		return Err({
			reason:
				'the frontmatter is not valid YAML; edit the complete source instead',
		});
	const contents = document.contents;
	if (contents !== null && !isMap(contents))
		return Err({ reason: 'the frontmatter is not a mapping' });
	if (contents?.flow)
		return Err({ reason: 'the frontmatter is a flow mapping' });
	const before = readValues(yaml);
	if (before.error) return before;

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	const appended: string[] = [];
	for (const [key, value] of entries) {
		const serialized = serializeValue(value);
		if (serialized.error) return serialized;
		const pair = contents?.items.find(
			(item) => isScalar(item.key) && item.key.value === key,
		);
		if (pair === undefined) {
			const text = yamlKey(key);
			if (text.error) return text;
			appended.push(`${text.data}: ${serialized.data}${newline}`);
			continue;
		}
		const node = pair.value;
		if (!isNode(node) || node.range == null)
			return Err({ reason: `the value of '${key}' has no source position` });
		if (isAlias(node) || (node as Node).anchor || (node as Node).tag)
			return Err({
				reason: `the value of '${key}' uses an anchor, alias, or tag`,
			});
		const [start, end] = node.range;
		const old = yaml.slice(start, end);
		const trailing = old.match(/(?:\r?\n[ \t]*)+$/)?.[0] ?? '';
		const lead = start > 0 && yaml[start - 1] === ':' ? ' ' : '';
		edits.push({ start, end, text: `${lead}${serialized.data}${trailing}` });
	}
	edits.sort((a, b) => b.start - a.start);
	let next = yaml;
	for (const edit of edits)
		next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
	if (appended.length > 0) {
		if (next !== '' && !next.endsWith('\n'))
			return Err({ reason: 'the frontmatter does not end with a line break' });
		next += appended.join('');
	}
	const verified = verifyFields(next, before.data, fields);
	if (verified.error) return verified;
	return Ok(next);
}

function readValues(
	yaml: string,
): Result<Record<string, unknown>, PatchRefusal> {
	const document = parseFrontmatter(yaml);
	if (document.errors.length > 0)
		return Err({ reason: 'the patched frontmatter is not valid YAML' });
	const converted = convertFrontmatter(document);
	if (converted.error)
		return Err({
			reason: `${converted.error.reason}; edit the complete source instead`,
		});
	return converted;
}

/** Refuse unless touched keys read back exactly and every other key is unchanged. */
function verifyFields(
	yaml: string,
	before: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>,
): Result<undefined, PatchRefusal> {
	const after = readValues(yaml);
	if (after.error) return after;
	const expected: Record<string, unknown> = { ...before, ...fields };
	const keys = new Set([...Object.keys(expected), ...Object.keys(after.data)]);
	for (const key of keys)
		if (!deepEqual(expected[key], after.data[key]))
			return Err({
				reason: `the patch would not preserve the value of '${key}'`,
			});
	return Ok(undefined);
}

function yamlKey(key: string): Result<string, PatchRefusal> {
	if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return Ok(key);
	return Ok(JSON.stringify(key));
}

/** One-line YAML for a value; JSON flow style is valid YAML 1.2. */
export function serializeValue(value: unknown): Result<string, PatchRefusal> {
	if (value === null) return Ok('null');
	if (typeof value === 'boolean') return Ok(value ? 'true' : 'false');
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			return Err({ reason: 'a number value is not finite' });
		return Ok(String(value));
	}
	if (typeof value === 'string') {
		const plain = stringify(value, { lineWidth: 0 }).replace(/\n$/, '');
		if (
			!plain.includes('\n') &&
			!plain.startsWith('|') &&
			!plain.startsWith('>')
		)
			return Ok(plain);
		return Ok(JSON.stringify(value));
	}
	if (
		Array.isArray(value) ||
		(typeof value === 'object' && value !== undefined)
	) {
		try {
			return Ok(JSON.stringify(value));
		} catch {
			return Err({ reason: 'a value cannot be written as YAML' });
		}
	}
	return Err({ reason: `a ${typeof value} value cannot be written as YAML` });
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	)
		return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) =>
		deepEqual(
			(left as Record<string, unknown>)[key],
			(right as Record<string, unknown>)[key],
		),
	);
}

/**
 * A new frontmatter block for the supplied fields, in their order, or an
 * empty string when there are none.
 */
function frontmatterBlock(
	fields: Readonly<Record<string, unknown>>,
	newline: '\n' | '\r\n',
): Result<string, PatchRefusal> {
	const entries = Object.entries(fields);
	if (entries.length === 0) return Ok('');
	let yaml = '';
	for (const [key, value] of entries) {
		const text = yamlKey(key);
		if (text.error) return text;
		const serialized = serializeValue(value);
		if (serialized.error) return serialized;
		yaml += `${text.data}: ${serialized.data}${newline}`;
	}
	const verified = verifyFields(yaml, {}, fields);
	if (verified.error) return verified;
	return Ok(`---${newline}${yaml}---${newline}`);
}

/** Complete source for a new row: frontmatter in the supplied field order, then the body. */
export function composeSource(
	fields: Readonly<Record<string, unknown>>,
	body: string,
): Result<string, PatchRefusal> {
	const newline = body.includes('\r\n') ? '\r\n' : '\n';
	const block = frontmatterBlock(fields, newline);
	if (block.error) return block;
	return Ok(block.data + body);
}
