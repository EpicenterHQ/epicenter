/**
 * The Markdown codec: split a file into a header and a body, split the header
 * into key blocks, read each with `yaml` on its own, and change a key by
 * replacing its block, so every other key, its order, quoting and comments
 * stay as their writer left them. Also the Git LFS pointer format, which is
 * how a blob's file reads.
 *
 * RULE: position decides the header and its keys, parsing decides each
 * value. A note's header is the text between a `---` first line and the
 * next `---` line, whether or not it parses; with no closing fence there is
 * none, and the whole text is body. Its keys are its key blocks
 * (`keyBlocks`); a key whose value does not parse costs only that key.
 */
import { type Document, isMap, isNode, isScalar, parseDocument, stringify } from 'yaml';

/** Values are written out in full: an alias would break when its anchor's key is removed. */
const PLAIN = { aliasDuplicateObjects: false } as const;

const OPEN = '---\n';
const CLOSE = '\n---\n';

/**
 * Where the header is, by position alone: the text starts with a `---`
 * line and a later line is exactly `---`. The door bounds the cost of
 * parsing this span before it is parsed; whether it parses is
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

/** The body as SQL over a row's `text`: the same body `bodyOf` reads. */
export const BODY_SQL = `CASE WHEN substr(text, 1, 4) = '---' || char(10) AND instr(substr(text || char(10), 4), char(10) || '---' || char(10)) > 0 THEN substr(text, instr(substr(text || char(10), 4), char(10) || '---' || char(10)) + 8) ELSE text END`;

export type ParsedMarkdown = {
	fields: Record<string, unknown>;
	body: string;
	/** The note has a header, by position. */
	hasFrontmatter: boolean;
	/** Keys whose value does not parse, or that the header holds twice: each costs only itself. */
	broken: string[];
};

/** One top-level key of a header: its lines, from any comments just above its key line to the next key's. */
export type KeyBlock = { key: string; text: string };

/**
 * The key a block's first line names, by position alone: what precedes its
 * first unquoted `:` that ends the line or is followed by a space (a quoted
 * key unquoted), or the whole line where there is none. No parse, so it
 * names a key whose value does not parse.
 */
function keyText(line: string): string {
	const text = line.replace(/\r?\n$/, '');
	let quote: string | null = null;
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (quote !== null) {
			if (char === '\\' && quote === '"') at++;
			else if (char === quote) quote = null;
		} else if ((char === '"' || char === "'") && text.slice(0, at).trim() === '') quote = char;
		else if (char === ':' && /^(\s|$)/.test(text.slice(at + 1))) return unquoted(text.slice(0, at).trimEnd());
	}
	return text.trimEnd();
}

const unquoted = (key: string) => {
	if (key.length > 1 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replaceAll("''", "'");
	if (key.length > 1 && key.startsWith('"') && key.endsWith('"'))
		try {
			return JSON.parse(key) as string;
		} catch {
			return key;
		}
	return key;
};

/**
 * RULE: a header is a list of key blocks, split by position, never by
 * `yaml`'s error recovery (which reads a broken line as part of its
 * neighbour). Each line at column 0 that is not blank, not a comment and
 * not a `- ` item (which continues the value above it) starts a block, which
 * runs to the next such line; comment lines at column 0 belong to the block
 * after them. Lines before the first block are the preamble. A header that
 * does not parse splits the same way.
 */
export function keyBlocks(yaml: string): { preamble: string; blocks: KeyBlock[] } {
	const lines = yaml.split(/(?<=\n)/).filter((line) => line !== '');
	let preamble = '';
	const blocks: KeyBlock[] = [];
	let comments = '';
	for (const line of lines) {
		const last = blocks.at(-1);
		if (line.startsWith('#')) comments += line;
		else if (/^(\s|-(\s|$))/.test(line) || line.trim() === '') {
			if (last === undefined) preamble += comments + line;
			else last.text += comments + line;
			comments = '';
		} else {
			blocks.push({ key: keyText(line), text: comments + line });
			comments = '';
		}
	}
	const last = blocks.at(-1);
	if (last === undefined) preamble += comments;
	else last.text += comments;
	return { preamble, blocks };
}

/** A key block's value, read on its own: null when the block is not that one key with a value that parses. */
function readBlock(block: KeyBlock): { value: unknown; document: Document } | null {
	const document = parseDocument(block.text, { prettyErrors: false, uniqueKeys: true });
	if (document.errors.length > 0 || !isMap(document.contents) || document.contents.items.length !== 1) return null;
	const pair = document.contents.items[0];
	if (pair === undefined || !isScalar(pair.key) || String(pair.key.value) !== block.key) return null;
	try {
		return { value: (document.toJS() as Record<string, unknown>)[block.key], document };
	} catch {
		// An alias with no anchor, or more aliases than `yaml` expands.
		return null;
	}
}

/**
 * A note as its header's preamble and key blocks (null when it has no
 * header) and its body.
 */
export function readNote(text: string) {
	const { yaml, bodyStart } = splitMarkdown(text);
	return { header: yaml === null ? null : keyBlocks(yaml), body: text.slice(bodyStart) };
}

/**
 * RULE: a broken key costs only that key. Each key's value is read on its
 * own; one that does not parse, or a key the header holds twice, is
 * `broken`, and every other key is a field.
 */
export function parseMarkdown(text: string): ParsedMarkdown {
	const { header, body } = readNote(text);
	const fields: Record<string, unknown> = {};
	const broken: string[] = [];
	const blocks = header?.blocks ?? [];
	for (const block of blocks) {
		const read = blocks.filter((other) => other.key === block.key).length === 1 ? readBlock(block) : null;
		if (read !== null) fields[block.key] = read.value;
		else if (!broken.includes(block.key)) broken.push(block.key);
	}
	return { fields, body, hasFrontmatter: header !== null, broken };
}

export type MarkdownChange = {
	/** Keys to set; a key set to `undefined` is removed. */
	fields?: Record<string, unknown>;
	body?: string;
};

/** How the house style prints YAML: `yaml`'s printer, never folding a line, flow collections unpadded. */
const HOUSE = { lineWidth: 0, flowCollectionPadding: false } as const;

/** A key and its value as house-style lines. */
const printKey = (key: string, value: unknown) => stringify({ [key]: value }, { ...PLAIN, ...HOUSE });

/** `document` printed in house style, when it reads back as one block of `key` holding `value`. */
function printed(document: Document, key: string, value: unknown) {
	let text: string;
	try {
		text = document.toString(HOUSE);
	} catch {
		return null;
	}
	const { preamble, blocks } = keyBlocks(text);
	const [only] = blocks;
	if (preamble !== '' || blocks.length !== 1 || only === undefined || only.key !== key) return null;
	const read = readBlock(only);
	return read !== null && sameValue(read.value, value) ? text : null;
}

/**
 * Apply a change to a file's text (null for a new file). A key's block is
 * replaced (its value set in place, so its comments stay, where it
 * parses), or appended; a removed key's block goes; a key held twice is
 * left once. Every other line stays as typed, so a patch works on a header
 * that does not parse and takes effect once it does. A text with no header
 * gains one.
 */
export function writeMarkdown(previous: string | null, change: MarkdownChange): string {
	const source = previous ?? '';
	const { yaml } = splitMarkdown(source);
	const body = change.body ?? bodyOf(source);
	const changes = Object.entries(change.fields ?? {});
	if (yaml === null) {
		const added = changes.filter(([, value]) => value !== undefined);
		if (added.length === 0) return withBody(source, body);
		return `${OPEN}${added.map(([key, value]) => printKey(key, value)).join('')}---\n${body}`;
	}
	if (changes.length === 0) return withBody(source, body);
	const { preamble, blocks } = keyBlocks(yaml);
	let out = blocks;
	for (const [key, value] of changes) {
		const at = out.findIndex((block) => block.key === key);
		const found = out[at];
		if (value === undefined || found === undefined) {
			out = value === undefined ? out.filter((block) => block.key !== key) : [...out, { key, text: printKey(key, value) }];
			continue;
		}
		const read = readBlock(found);
		let text = printKey(key, value);
		if (read !== null) {
			if (sameValue(read.value, value)) text = found.text;
			else {
				const old = read.document.get(key, true);
				const node = read.document.createNode(value, PLAIN);
				if (isNode(old) && isNode(node)) node.comment = old.comment;
				read.document.set(key, node);
				text = printed(read.document, key, value) ?? text;
			}
		}
		out = out.flatMap((block, n) => (n === at ? [{ key, text }] : block.key === key ? [] : [block]));
	}
	return `${OPEN}${preamble}${out.map((block) => block.text).join('')}---\n${body}`;
}

/** A key block in house style: printed by `yaml` where its value parses, comments kept; as typed where it does not. */
function houseBlock(block: KeyBlock) {
	const read = readBlock(block);
	return read === null ? block.text : (printed(read.document, block.key, read.value) ?? block.text);
}

/**
 * RULE: the house style, which the server applies to every note that lands:
 * each key that parses printed one way (`yaml`'s printer, comments, quoting
 * and key order kept), a broken key and the preamble left exactly as typed,
 * and the body never touched. Deterministic and idempotent.
 */
export function formatMarkdown(text: string): string {
	const { yaml, bodyStart } = splitMarkdown(text);
	if (yaml === null) return text;
	const { preamble, blocks } = keyBlocks(yaml);
	const twice = (key: string) => blocks.filter((block) => block.key === key).length > 1;
	return `${OPEN}${preamble}${blocks.map((block) => (twice(block.key) ? block.text : houseBlock(block))).join('')}---\n${text.slice(bodyStart)}`;
}

/** A text's body: what follows its header, or the whole text when it has none. */
export const bodyOf = (text: string) => text.slice(splitMarkdown(text).bodyStart);

/** A text's header with its fences, byte for byte, whether or not it parses: empty when it has none. */
export const headerOf = (text: string) => text.slice(0, splitMarkdown(text).bodyStart);

/**
 * `text` with its body replaced by `body`, its header kept byte for byte,
 * so an editor's body never touches the header.
 */
export function withBody(text: string, body: string) {
	const header = headerOf(text);
	// A closing fence at the very end has no newline after it yet.
	if (header !== '' && !header.endsWith('\n') && body !== '') return `${header}\n${body}`;
	return `${header === '' ? emptyHeaderFor(body) : header}${body}`;
}

/** RULE: a body after no header must not itself read as one: one that opens with fences gets an empty header. */
export const emptyHeaderFor = (body: string) => (splitMarkdown(body).yaml === null ? '' : `${OPEN}---\n`);

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
