/**
 * Today's engine's parse rule, which design B replaces with one predicate,
 * `admissible` in core/door (D4: every shared note parses). It lives here,
 * outside core, only until the old engine and its server are deleted.
 *
 * The rule is a transition: no write may turn a note whose frontmatter
 * parses into one whose frontmatter does not.
 */
import { parseMarkdown, parsePointer, parses } from './core/markdown.js';

/** Notes larger than this, stored, are refused. */
const MAX_NOTE_BYTES = 1024 * 1024;

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
