// vocab-check: ignore-file (YAML's own term: a plain or quoted scalar is a YAML node kind)
/**
 * The row codec under `parseRowSource` and `formatRowSource`: complete fields and the
 * Markdown body, with no schema.
 *
 * A document is every frontmatter field as an unvalidated JSON value plus the
 * Markdown body as opaque text. Parsing builds values by walking the YAML
 * syntax tree, so anything that would convert lossily (custom tags, binary,
 * sets, timestamps, non-string keys, unsafe integers, non-finite numbers,
 * lone surrogates, cyclic aliases) is refused before a value exists. Alias
 * expansions and converted values are bounded, so a small file cannot expand
 * into an unbounded one. A refusal of source names the line it points at.
 *
 * Formatting writes one fixed text for a document and a declared key order:
 * declared keys first in declared order, other keys in UTF-16 code unit
 * order, nested mapping keys in that order too, as block-style YAML. Scalars are plain wherever a YAML 1.2 reader and a
 * YAML 1.1 reader read the same value, and quoted elsewhere; multi-line
 * strings are literal blocks. Comments, quoting, key order, a byte-order
 * mark, and header CRLF are normalized away. The body is appended byte for
 * byte. Formatted text is parsed again before it is returned, so whatever
 * this writes, this reads back as the same document.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	parseDocument,
} from 'yaml';
import { frameRowText } from './markdown.js';

/** A JSON value with an exact YAML and JSON form. */
type CanonicalValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue };

/** Every frontmatter field, declared or not, and the body after the closing fence. */
export type CanonicalDocument = {
	readonly fields: { readonly [key: string]: CanonicalValue };
	readonly body: string;
};

/** Value equality ignores mapping order, while arrays and mappings remain whole units. */
export function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	const a = left as Record<string, unknown>;
	const b = right as Record<string, unknown>;
	return (
		Object.keys(a).length === Object.keys(b).length &&
		Object.keys(a).every(
			(key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]),
		)
	);
}

/**
 * Why source or a document has no canonical form. `path` locates the value
 * within its field. A refusal of source has the 1-based `line` of the whole
 * source it points at; a refusal of a document has none.
 */
export type CanonicalRefusal = {
	readonly reason: string;
	readonly path: readonly (string | number)[];
	readonly line?: number;
	/** The top-level field the refusal is inside; absent for the body and the document as a whole. */
	readonly field?: string;
};

type Path = readonly (string | number)[];

const refuse = (
	reason: string,
	path: Path = [],
	line?: number,
): Result<never, CanonicalRefusal> =>
	Err(line === undefined ? { reason, path } : { reason, path, line });

/** Alias expansions allowed per document; more is refused, not evaluated. */
const MAX_ALIAS_EXPANSIONS = 100;
/** Converted nodes allowed per document, counting every alias expansion. */
const MAX_NODES = 10_000;

const TAG = 'tag:yaml.org,2002:';
const SCALAR_TAGS = new Set(
	['str', 'int', 'float', 'bool', 'null'].map((t) => TAG + t),
);

type Walk = {
	readonly document: Document.Parsed;
	readonly converting: Set<unknown>;
	/** The whole source and where its YAML starts, to locate refusals. */
	readonly source: string;
	readonly yamlStart: number;
	aliases: number;
	nodes: number;
};

/** The 1-based line of a UTF-16 index in source. A CRLF is one line break. */
function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 0x0a) line++;
	return line;
}

/** The line where a YAML node starts, when the parser recorded its range. */
function lineOf(walk: Walk, node: unknown): number | undefined {
	const start = (node as { range?: readonly number[] | null } | null)
		?.range?.[0];
	return start === undefined
		? undefined
		: lineAt(walk.source, walk.yamlStart + start);
}

/**
 * Parse framed Markdown into its complete document, and say where its
 * top-level keys are. Every field is kept, declared or not, without schema
 * validation. A refusal carries no partial document, and the line of the
 * source it points at; keep the original text available for raw repair.
 * Parsing does not retain frontmatter comments or presentation. A refusal
 * inside a top-level field names that `field`. Internal to the package.
 */
export function parseRowSource(source: string): Result<
	{
		readonly document: CanonicalDocument;
		/** Top-level keys in source order, including integer-looking names. */
		readonly keyOrder: readonly string[];
		/**
		 * The 1-based line of a top-level field's value at a JSON pointer
		 * within it, or else of the field's key; found only when asked.
		 */
		lineOf(field: string, pointer?: string): number | undefined;
	},
	CanonicalRefusal
> {
	const frame = frameRowText(source);
	if (frame.kind === 'missing')
		return Ok({
			document: { fields: {}, body: source.slice(frame.bom.length) },
			keyOrder: [],
			lineOf: () => undefined,
		});
	if (frame.kind === 'unclosed')
		return refuse(
			'The frontmatter opening line has no closing --- line',
			[],
			1,
		);
	const document = parseDocument(source.slice(frame.yamlStart, frame.yamlEnd), {
		prettyErrors: false,
		uniqueKeys: true,
		version: '1.2',
		// Keeps integers exact so unsafe ones are refused instead of rounded.
		intAsBigInt: true,
	});
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined)
		return refuse(
			`The frontmatter is not supported YAML: ${problem.message}`,
			[],
			lineAt(source, frame.yamlStart + problem.pos[0]),
		);
	const body = source.slice(frame.bodyStart);
	if (!body.isWellFormed())
		return refuse(
			'The body contains a lone surrogate',
			['body'],
			lineAt(source, frame.bodyStart),
		);
	const walk: Walk = {
		document,
		converting: new Set(),
		source,
		yamlStart: frame.yamlStart,
		aliases: 0,
		nodes: 0,
	};
	if (document.contents === null)
		return Ok({
			document: { fields: {}, body },
			keyOrder: [],
			lineOf: () => undefined,
		});
	if (!isMap(document.contents))
		return refuse(
			'The frontmatter is not a mapping',
			[],
			lineOf(walk, document.contents),
		);
	const { data: fields, error: fieldsError } = convert(
		document.contents,
		[],
		walk,
	);
	if (fieldsError !== null) {
		const [field] = fieldsError.path;
		return Err(
			typeof field === 'string' ? { ...fieldsError, field } : fieldsError,
		);
	}
	const root = document.contents;
	return Ok({
		document: { fields: fields as CanonicalDocument['fields'], body },
		keyOrder: root.items.map((pair) => (pair.key as { value: string }).value),
		lineOf(field, pointer) {
			// Conversion refused every key that is not a string scalar.
			const pair = root.items.find(
				(p) => isScalar(p.key) && p.key.value === field,
			);
			if (pair === undefined) return undefined;
			const segments = (pointer ?? '')
				.split('/')
				.slice(1)
				.map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
			let node: unknown = pair.value;
			for (const segment of segments) {
				if (isMap(node))
					node = node.items.find(
						(p) => isScalar(p.key) && p.key.value === segment,
					)?.value;
				else if (isSeq(node)) node = node.items[Number(segment)];
				else node = undefined;
			}
			return lineOf(walk, node) ?? lineOf(walk, pair.key);
		},
	});
}

/**
 * Convert one node, and locate a refusal at the innermost node that made it:
 * a refusal that already has a line passes through unchanged.
 */
function convert(
	node: unknown,
	path: Path,
	walk: Walk,
): Result<CanonicalValue, CanonicalRefusal> {
	const converted = convertNode(node, path, walk);
	if (converted.error === null || converted.error.line !== undefined)
		return converted;
	const line = lineOf(walk, node);
	return line === undefined
		? converted
		: refuse(converted.error.reason, converted.error.path, line);
}

function convertNode(
	node: unknown,
	path: Path,
	walk: Walk,
): Result<CanonicalValue, CanonicalRefusal> {
	if (++walk.nodes > MAX_NODES)
		return refuse('The frontmatter expands to too many values', path);
	if (node === null) return Ok(null);
	if (isAlias(node)) {
		if (++walk.aliases > MAX_ALIAS_EXPANSIONS)
			return refuse('The frontmatter expands too many aliases', path);
		const target = node.resolve(walk.document);
		if (target === undefined)
			return refuse(`The alias *${node.source} has no anchor`, path);
		if (walk.converting.has(target))
			return refuse(`The alias *${node.source} is circular`, path);
		return convert(target, path, walk);
	}
	if (isScalar(node)) {
		if (node.tag !== undefined && !SCALAR_TAGS.has(node.tag))
			return refuse(`The tag ${node.tag} is not supported`, path);
		const { value } = node;
		if (value === null || typeof value === 'boolean') return Ok(value);
		if (typeof value === 'string')
			return value.isWellFormed()
				? Ok(value)
				: refuse('A string contains a lone surrogate', path);
		if (typeof value === 'bigint') {
			// `intAsBigInt` reads `-0` as `0n`; the source keeps the sign.
			if (value === 0n) return Ok(node.source?.startsWith('-') ? -0 : 0);
			if (
				value > BigInt(Number.MAX_SAFE_INTEGER) ||
				value < BigInt(Number.MIN_SAFE_INTEGER)
			)
				return refuse('An integer is outside the safe range', path);
			return Ok(Number(value));
		}
		if (typeof value === 'number') return numberValue(value, path);
		return refuse('A scalar has no JSON value', path);
	}
	walk.converting.add(node);
	try {
		if (isSeq(node)) {
			if (node.tag !== undefined && node.tag !== `${TAG}seq`)
				return refuse(`The tag ${node.tag} is not supported`, path);
			const items: CanonicalValue[] = [];
			for (const [index, item] of node.items.entries()) {
				const { data: value, error: valueError } = convert(
					item,
					[...path, index],
					walk,
				);
				if (valueError !== null) return Err(valueError);
				items.push(value);
			}
			return Ok(items);
		}
		if (isMap(node)) {
			if (node.tag !== undefined && node.tag !== `${TAG}map`)
				return refuse(`The tag ${node.tag} is not supported`, path);
			const record: Record<string, CanonicalValue> = {};
			for (const pair of node.items) {
				const key = pair.key;
				if (
					!isScalar(key) ||
					typeof key.value !== 'string' ||
					(key.tag !== undefined && key.tag !== `${TAG}str`)
				)
					return refuse(
						'A mapping key is not a string',
						path,
						lineOf(walk, key),
					);
				if (!key.value.isWellFormed())
					return refuse(
						'A mapping key contains a lone surrogate',
						path,
						lineOf(walk, key),
					);
				const { data: value, error: valueError } = convert(
					pair.value,
					[...path, key.value],
					walk,
				);
				if (valueError !== null) return Err(valueError);
				defineOwn(record, key.value, value);
			}
			return Ok(record);
		}
	} finally {
		walk.converting.delete(node);
	}
	return refuse('The frontmatter contains an unsupported node', path);
}

function numberValue(
	value: number,
	path: Path,
): Result<number, CanonicalRefusal> {
	if (!Number.isFinite(value)) return refuse('A number is not finite', path);
	if (Number.isInteger(value) && !Number.isSafeInteger(value))
		return refuse('An integer is outside the safe range', path);
	return Ok(value);
}

/** An own data property, so `__proto__` is a key and never a prototype. */
function defineOwn(
	record: Record<string, unknown>,
	key: string,
	value: unknown,
) {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/**
 * The canonical text of a document, and the document that text reads back
 * as. The text is the same bytes for the same document and existing key
 * order, whatever source it was
 * read from. Refused when a value has no exact JSON and YAML form, or when
 * the text would not parse back to the document. This checks
 * representation, not field schemas, and writes nothing. Pass the parsed
 * source's key order to retain existing keys and append new ones alphabetically.
 *
 * Only `fields` and `body` are read, once each, so a value carrying other
 * properties formats as its document. An untyped caller's document that is
 * not an object, or whose body is not a string, is refused, not thrown.
 *
 * The frontmatter is block-style YAML with plain scalars wherever a YAML 1.2
 * reader and a YAML 1.1 reader both read the same value, and quoted
 * scalars elsewhere: `yes`, `off`, `2026-10-11`, `0o17`, and `1:30` are
 * strings in both. Multi-line strings are literal blocks. An `undefined`
 * value in a mapping is an absent key, as in JSON.
 */
export function formatRowSource(
	document: unknown,
	declaredKeys: readonly string[],
): Result<{ text: string; document: CanonicalDocument }, CanonicalRefusal> {
	if (typeof document !== 'object' || document === null)
		return refuse('The document is not an object');
	const fields = 'fields' in document ? document.fields : undefined;
	const body = 'body' in document ? document.body : undefined;
	if (typeof body !== 'string')
		return refuse('The body is not a string', ['body']);
	if (!body.isWellFormed())
		return refuse('The body contains a lone surrogate', ['body']);
	const declared = new Set(declaredKeys);
	if (declared.size !== declaredKeys.length)
		return refuse('A declared key is listed twice');
	if (!isPlainRecord(fields))
		return refuse('The fields are not a plain object');
	const extra = Object.keys(fields)
		.filter((key) => !declared.has(key))
		.sort(compareKeys);
	const keys = [
		...declaredKeys.filter((key) => Object.hasOwn(fields, key)),
		...extra,
	];
	// A Map keeps this order; an object would put integer-like keys first.
	const owned: OwnedMap = new Map();
	for (const key of keys) {
		if (!key.isWellFormed())
			return refuse('A key contains a lone surrogate', [key]);
		const value = fields[key];
		if (value === undefined) continue;
		const { data: copy, error } = ownValue(value, [key], new Set());
		if (error !== null) return Err({ ...error, field: key });
		owned.set(key, copy);
	}
	const header = mappingLines(owned, '');
	const text = `---\n${header}---\n${body}`;
	const { data: reread, error: parseError } = parseRowSource(text);
	if (parseError !== null)
		return refuse(`The canonical text does not parse: ${parseError.reason}`);
	if (
		reread.document.body !== body ||
		!sameAsOwned(reread.document.fields, owned)
	)
		return refuse('The canonical text does not read back as the document');
	return Ok({ text, document: reread.document });
}

/**
 * Block-style YAML lines for a mapping at an indentation. Every scalar is
 * written so that a YAML 1.2 reader and a YAML 1.1 reader (PyYAML, Ruby's
 * Psych, Go's yaml.v2) read the same value; anything doubtful is quoted.
 */
function mappingLines(map: OwnedMap, indent: string): string {
	let lines = '';
	for (const [key, value] of map) {
		const name = scalarText(key);
		lines += isNested(value)
			? `${indent}${name}:\n${collectionLines(value, `${indent}  `)}`
			: `${indent}${name}: ${valueText(value, indent)}\n`;
	}
	return lines;
}

/** Block-style YAML lines for a sequence at an indentation. */
function sequenceLines(items: OwnedValue[], indent: string): string {
	let lines = '';
	for (const item of items) {
		if (!isNested(item)) {
			lines += `${indent}- ${valueText(item, indent)}\n`;
			continue;
		}
		// The item's first line follows its dash: `- key: value` or `- - item`.
		const nested = collectionLines(item, `${indent}  `);
		lines += `${indent}- ${nested.slice(indent.length + 2)}`;
	}
	return lines;
}

function collectionLines(value: OwnedMap | OwnedValue[], indent: string) {
	return value instanceof Map
		? mappingLines(value, indent)
		: sequenceLines(value, indent);
}

/** A non-empty mapping or sequence, which takes its own lines. */
function isNested(value: OwnedValue): value is OwnedMap | OwnedValue[] {
	return value instanceof Map
		? value.size > 0
		: Array.isArray(value) && value.length > 0;
}

/** A value written after its key or dash, at the indentation of that line. */
function valueText(value: OwnedValue, indent: string): string {
	if (value instanceof Map) return '{}';
	if (Array.isArray(value)) return '[]';
	if (value === null) return 'null';
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number') return numberText(value);
	if (isLiteralBlock(value)) {
		const content = value.endsWith('\n') ? value.slice(0, -1) : value;
		const lines = content
			.split('\n')
			.map((line) => (line === '' ? '' : `${indent}  ${line}`));
		return `${value.endsWith('\n') ? '|' : '|-'}\n${lines.join('\n')}`;
	}
	return scalarText(value);
}

/**
 * A number every YAML reader reads as this number. Floats keep a decimal
 * point, since a YAML 1.1 reader reads `1e-7` as a string, and negative
 * zero is `-0.0`, since `-0` is integer zero there.
 */
function numberText(value: number): string {
	if (Object.is(value, -0)) return '-0.0';
	return String(value).replace(/^(-?\d+)e/, '$1.0e');
}

/**
 * A string as a plain scalar only when every YAML reader reads it as this
 * same string: it starts with a letter or `_`, holds only letters, digits,
 * spaces, and `_ . , ' ( ) / -`, does not end with a space, and is no
 * boolean or null word in any case. Every other string is double-quoted.
 */
function scalarText(text: string): string {
	return PLAIN.test(text) && !RESERVED.test(text) ? text : quoted(text);
}

const PLAIN = /^[\p{L}_](?:[\p{L}\p{N}_.,'()/ -]*[\p{L}\p{N}_.,'()/-])?$/u;
const RESERVED = /^(?:y|n|yes|no|on|off|true|false|null)$/i;

/**
 * A multi-line string as a literal block when every reader keeps it exactly:
 * no tab or special character anywhere, a first line that starts with
 * neither a space nor a line break, and at most one trailing line break.
 */
function isLiteralBlock(text: string): boolean {
	return (
		text.includes('\n') &&
		![...text].some(
			(char) => char !== '\n' && (char < ' ' || isSpecialCharacter(char)),
		) &&
		!text.startsWith(' ') &&
		!text.startsWith('\n') &&
		!text.endsWith('\n\n')
	);
}

/**
 * A YAML double-quoted scalar. JSON escapes are YAML escapes; the characters
 * some YAML reader rejects or rewrites when unescaped (DEL, C1 controls
 * including NEL, the line and paragraph separators, and U+FEFF, U+FFFE,
 * U+FFFF) are escaped too.
 */
function quoted(text: string): string {
	return [...JSON.stringify(text)]
		.map((char) =>
			isSpecialCharacter(char)
				? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
				: char,
		)
		.join('');
}

/**
 * A character some YAML reader rejects or rewrites when it is written as is:
 * DEL, a C1 control (NEL included), a line or paragraph separator, or
 * U+FEFF, U+FFFE, U+FFFF.
 */
function isSpecialCharacter(char: string): boolean {
	const code = char.charCodeAt(0);
	return (
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0xfeff ||
		code === 0xfffe ||
		code === 0xffff
	);
}

/** A value ready to write: mappings are Maps, so their key order is the written order. */
type OwnedValue = null | boolean | number | string | OwnedValue[] | OwnedMap;
type OwnedMap = Map<string, OwnedValue>;

/**
 * The JSON value of a supplied value, copied with mapping keys in UTF-16
 * code unit order, or why it has none. An `undefined` mapping value is left
 * out; anything else that JSON or YAML would lose is refused.
 */
function ownValue(
	value: unknown,
	path: Path,
	ancestors: Set<object>,
): Result<OwnedValue, CanonicalRefusal> {
	if (value === null || typeof value === 'boolean') return Ok(value);
	if (typeof value === 'number') return numberValue(value, path);
	if (typeof value === 'string')
		return value.isWellFormed()
			? Ok(value)
			: refuse('A string contains a lone surrogate', path);
	if (typeof value !== 'object')
		return refuse(`A ${typeof value} has no JSON value`, path);
	if (ancestors.has(value)) return refuse('A value contains itself', path);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			// Holes, extra properties, and symbols would be lost.
			if (Reflect.ownKeys(value).length !== value.length + 1)
				return refuse('An array has holes or extra properties', path);
			const items: OwnedValue[] = [];
			for (const [index, item] of value.entries()) {
				const { data: copy, error } = ownValue(
					item,
					[...path, index],
					ancestors,
				);
				if (error !== null) return Err(error);
				items.push(copy);
			}
			return Ok(items);
		}
		if (!isPlainRecord(value))
			return refuse('An object is not a plain JSON object', path);
		const record: OwnedMap = new Map();
		for (const key of Object.keys(value).sort(compareKeys)) {
			if (!key.isWellFormed())
				return refuse('A key contains a lone surrogate', [...path, key]);
			if (value[key] === undefined) continue;
			const { data: copy, error } = ownValue(
				value[key],
				[...path, key],
				ancestors,
			);
			if (error !== null) return Err(error);
			record.set(key, copy);
		}
		return Ok(record);
	} finally {
		ancestors.delete(value);
	}
}

/**
 * A copy of typed `fields` as the canonical writer takes them, or why it
 * would refuse them: each value as its JSON value, read through any proxy,
 * so a later change of the caller's objects changes nothing. A field whose
 * value is `undefined` stays, as the removal it means.
 */
export function ownFields(
	fields: unknown,
): Result<Record<string, unknown>, CanonicalRefusal> {
	if (!isPlainRecord(fields)) return refuse('The fields are not a plain object');
	let copy: Record<string, unknown> = {};
	for (const key of Object.keys(fields)) {
		const value = fields[key];
		let owned: unknown;
		if (value !== undefined) {
			const { data, error } = ownValue(value, [key], new Set());
			if (error !== null) return Err({ ...error, field: key });
			owned = plainOf(data);
		}
		copy = Object.defineProperty(copy, key, {
			value: owned,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return Ok(copy);
}

/** An owned value as plain arrays and objects. */
function plainOf(value: OwnedValue): unknown {
	if (Array.isArray(value)) return value.map(plainOf);
	if (!(value instanceof Map)) return value;
	const record: Record<string, unknown> = {};
	for (const [key, item] of value)
		Object.defineProperty(record, key, {
			value: plainOf(item),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	return record;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	// Symbol keys and non-enumerable properties would be lost.
	return (
		(prototype === Object.prototype || prototype === null) &&
		Reflect.ownKeys(value).length === Object.keys(value).length
	);
}

/** UTF-16 code unit order: fixed, locale-independent, and total. */
function compareKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether a parsed value is the owned value it was written from. */
function sameAsOwned(parsed: unknown, owned: OwnedValue): boolean {
	if (owned instanceof Map)
		return (
			isPlainRecord(parsed) &&
			Object.keys(parsed).length === owned.size &&
			[...owned].every(
				([key, value]) =>
					Object.hasOwn(parsed, key) && sameAsOwned(parsed[key], value),
			)
		);
	if (Array.isArray(owned))
		return (
			Array.isArray(parsed) &&
			parsed.length === owned.length &&
			owned.every((item, index) => sameAsOwned(parsed[index], item))
		);
	return Object.is(parsed, owned);
}
