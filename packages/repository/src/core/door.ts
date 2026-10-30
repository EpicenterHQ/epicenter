/**
 * The door: one pure predicate, `admissible(path, text)`, that the device,
 * the server and a GitHub Action all run, so a text the door would refuse
 * is held on the device before it is ever sent.
 *
 * Enforced: every note (`.md`, in any case) is LF-only with no byte order
 * mark, is at most 1 MB and is never an LFS pointer, and its
 * frontmatter is cheap to parse (at most `FRONTMATTER_KEYS` keys and
 * `FRONTMATTER_VALUES` scalars, nested at most `FRONTMATTER_NESTING` deep); every text is
 * valid UTF-8 with no NUL; every other file is a blob, kept as a canonical
 * Git LFS pointer of at most `MAX_BLOB_BYTES` (the one file-type rule:
 * Markdown merges, everything else is bytes by LFS); paths are portable
 * (NFC, no `.git` component, names legal on Windows and macOS, segments at
 * most 255 bytes); Epicenter owns `.gitattributes`, `.lfsconfig` and
 * `.gitmodules`, as files and as folders.
 *
 * Warned only (`lint`): malformed or unresolved conflict blocks, a long
 * total path.
 *
 * The server adds what needs the tree: paths equal after NFC and case
 * folding are one path, a name is a file or a folder, never both
 * (core/tree's `collision`), a pointer's bytes are present at its size, a blob
 * write lands only over the blob its writer saw (core/settle,
 * `settlePointer`), and a merge may not grow a note past 1 MB or past `BLOCK_CAP` conflict
 * blocks (core/settle, which also never writes an identical block twice).
 */
import { CST, Lexer } from 'yaml';
import { findConflicts } from './conflict.js';
import { parsePointer, splitMarkdown } from './markdown.js';
import { COLLISIONS } from './tree.js';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
/** The most bytes a note may hold. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** The most bytes a blob may hold (2 GiB), on every device and by default on the server. */
export const MAX_BLOB_BYTES = 2 * 1024 ** 3;

/** Repository control files only Epicenter writes. */
export const CONTROL = new Set(['.gitattributes', '.lfsconfig', '.gitmodules']);
/**
 * What Epicenter writes into `.gitattributes`, the same in every
 * repository: every file through Git LFS, then notes (`.md` in any case)
 * and this file itself back to plain text with LF endings.
 */
export const ATTRIBUTES = '* filter=lfs diff=lfs merge=lfs -text\n*.[mM][dD] !filter !diff !merge text eol=lf\n.gitattributes !filter !diff !merge text eol=lf\n';

/** A note is a path ending `.md` in any case. */
export const isNote = (path: string) => path.toLowerCase().endsWith('.md');
/** One path's identity: equal after NFC and case folding means the same path. */
export const fold = (path: string) => path.normalize('NFC').toLowerCase();

const ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/;
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A path past the server's bound on path bytes. */
export const PATH_TOO_LONG = 'the path is too long';
/** A file whose name folds (NFC, case) to another file's: the repository holds one path for both. */
export const TWIN = 'another file has this name in different letters';
/** A note whose bytes are not UTF-8 text. */
export const NOT_UTF8 = 'not UTF-8 text';
const NOT_TEXT = ['the text is not valid UTF-8', 'binary files go through Git LFS'];

/**
 * RULE: what is not sent is either waiting (the system clears it: bytes to
 * upload, a size or bound) or refused: what only a person can fix, because
 * the repository cannot represent it. That is an unportable name (any path
 * refusal, or one past the path bound), a name another file has in other
 * letters, a note that is not text, or a file where a folder is, or the
 * reverse.
 */
export function onlyAPersonFixes(path: string, reason: string) {
	return pathRefusal(path) !== null || reason === PATH_TOO_LONG || reason === TWIN || reason === NOT_UTF8 || NOT_TEXT.includes(reason) || Object.values<string>(COLLISIONS).includes(reason);
}

/** Why a path is not portable, or null. */
export function pathRefusal(path: string): string | null {
	if (path === '' || path.startsWith('/') || path.includes('\\')) return 'bad path';
	if (path !== path.normalize('NFC')) return 'the path is not NFC';
	const segments = path.split('/');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') return 'bad path';
		const lower = segment.toLowerCase();
		if (lower === '.git' || /^git~\d+$/.test(lower)) return '.git is reserved';
		if (ILLEGAL.test(segment)) return 'a name may not hold < > : " \\ | ? * or control characters';
		if (/[ .]$/.test(segment)) return 'a name may not end in a space or a period';
		if (DEVICE.test(segment)) return 'a name may not be a reserved device name';
		if (bytes(segment) > 255) return 'a name may be at most 255 bytes';
	}
	if (segments[0]?.toLowerCase() === '.epicenter') return 'Epicenter owns this file';
	// A control file's name is Epicenter's as a folder too: Git's tree has a file there.
	if (segments.some((segment) => CONTROL.has(segment.toLowerCase()))) return 'Epicenter owns this file';
	return null;
}

/** Why the repository may not hold `text` at `path` (null deletes), or null when it may. */
export function admissible(path: string, text: string | null): string | null {
	const refusal = pathRefusal(path);
	if (refusal !== null || text === null) return refusal;
	if (text.includes('\0')) return NOT_TEXT[1] as string;
	if (LONE_SURROGATE.test(text)) return NOT_TEXT[0] as string;
	const pointer = parsePointer(text);
	if (isNote(path)) {
		if (pointer !== null) return 'a note may not be an LFS pointer';
		if (text.startsWith('\uFEFF')) return 'a note may not start with a byte order mark';
		if (text.includes('\r')) return 'a note must use LF line endings';
		if (bytes(text) > MAX_FILE_BYTES) return 'a note may be at most 1 MB';
		return frontmatterRefusal(text);
	}
	if (pointer === null) return 'a file other than a note goes through Git LFS';
	if (pointer.size > MAX_BLOB_BYTES) return 'a file may be at most 2 GiB';
	return null;
}

// ============================================================================
// Frontmatter parse cost: bounded before the YAML is parsed
// ============================================================================

/**
 * The most keys a note's frontmatter may hold, across all its mappings.
 * Checking keys for uniqueness is quadratic in a mapping's size: deployed
 * spike 3 measured 12.9 s of Durable Object CPU for 40,000 keys in an
 * 858 KB note; locally 1,000 keys parse in about 15 ms and 10,000 in 260 ms.
 */
export const FRONTMATTER_KEYS = 1000;

/**
 * The deepest a note's frontmatter may nest, counted as the columns of
 * block structure (indentation, or `- ` and `? ` indicators) plus the open
 * flow brackets: an upper bound on its depth, since each nested block
 * collection sits further right. Deployed spike 3 overflowed the parser's
 * stack at 1,000 nested brackets.
 */
export const FRONTMATTER_NESTING = 64;

/**
 * The most scalars (keys and values) a note's frontmatter may hold. Parsing
 * is linear in them but not cheap: a 1 MB flow sequence of 250,000 items
 * parses in about 330 ms locally; 10,000 cost about 13 ms.
 */
export const FRONTMATTER_VALUES = 10_000;

/** Zero-width marks `yaml`'s lexer puts in its token stream (document, flow error end, scalar). */
const DOC_MODE = '\u0002';
const FLOW_ERROR_END = '\u0018';
const SCALAR = '\u001f';

/**
 * Why a note's frontmatter would cost too much to parse, or null. One pass
 * over `yaml`'s lexer, which is linear and builds no document, stopping at
 * the first bound passed; it overcounts in flow mappings, never under.
 */
function frontmatterRefusal(text: string): string | null {
	const { yaml } = splitMarkdown(text);
	if (yaml === null) return null;
	let keys = 0;
	let values = 0;
	let column = 0;
	let atLineStart = true;
	/** The column block structure has reached on this line: its indent, or a `- ` or `? ` further right. */
	let blockColumn = 0;
	let isValue = false;
	const flow: ('{' | '[')[] = [];
	for (const token of new Lexer().lex(yaml)) {
		if (token === DOC_MODE || token === FLOW_ERROR_END) continue;
		if (token === SCALAR) {
			isValue = true;
			continue;
		}
		const start = column;
		const newline = token.lastIndexOf('\n');
		column = newline < 0 ? column + token.length : token.length - newline - 1;
		const type = isValue ? 'value' : CST.tokenType(token);
		isValue = false;
		if (type === 'newline') {
			atLineStart = true;
			continue;
		}
		if (type === 'space' || type === 'comment') continue;
		if (atLineStart && flow.length === 0) blockColumn = start;
		atLineStart = false;
		const inFlowMap = flow.at(-1) === '{';
		switch (type) {
			case 'seq-item-ind':
				if (flow.length === 0) blockColumn = start;
				break;
			case 'explicit-key-ind':
				if (flow.length === 0) blockColumn = start;
				if (!inFlowMap) keys++;
				break;
			case 'map-value-ind':
				if (!inFlowMap) keys++;
				break;
			case 'flow-map-start':
			case 'flow-seq-start':
				if (inFlowMap) keys++;
				flow.push(token === '{' ? '{' : '[');
				break;
			case 'flow-map-end':
			case 'flow-seq-end':
				flow.pop();
				break;
			default:
				if (type === 'value' || type === 'single-quoted-scalar' || type === 'double-quoted-scalar') values++;
				// A scalar: inside a flow mapping, count each as a possible key.
				if (inFlowMap) keys++;
		}
		if (values > FRONTMATTER_VALUES) return `the frontmatter may hold at most ${FRONTMATTER_VALUES} values`;
		if (keys > FRONTMATTER_KEYS) return `the frontmatter may hold at most ${FRONTMATTER_KEYS} keys`;
		if (blockColumn + flow.length > FRONTMATTER_NESTING) return `the frontmatter may nest at most ${FRONTMATTER_NESTING} deep`;
	}
	return null;
}

/** Warnings only: nothing here refuses. */
export function lint(path: string, text: string | null): string[] {
	if (text === null) return [];
	const warnings: string[] = [];
	const opens = text.split('\n').filter((line) => line.startsWith('<<<<<<< ')).length;
	const blocks = findConflicts(text).length;
	if (blocks > 0) warnings.push(`${blocks} unresolved conflict block${blocks === 1 ? '' : 's'}`);
	if (opens > blocks) warnings.push('a malformed conflict block');
	if (bytes(path) > 260) warnings.push('a long path');
	return warnings;
}

/** A path segment from a title that the door admits: lower case, legal on every system, never a reserved name. */
export function slug(title: string) {
	let out = title
		.normalize('NFC')
		.toLowerCase()
		.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-. ]+|[-. ]+$/g, '');
	while (bytes(out) > 200) out = out.slice(0, -1);
	if (out === '' || out === 'git' || DEVICE.test(out) || out.startsWith('.')) out = `${out.replace(/^\.+/, '')}-note`.replace(/^-/, '');
	return out;
}
