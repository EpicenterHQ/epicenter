/**
 * The door: one pure predicate, `admissible(path, text)`, that the device,
 * the server and a GitHub Action all run, so a text the door would refuse
 * is held on the device before it is ever sent.
 *
 * Enforced: every note (`.md`, in any case) parses, is LF-only with no byte
 * order mark, is at most 1 MB and is never an LFS pointer; every text is
 * valid UTF-8 with no NUL; every non-LFS file is at most 1 MB; a blob is a
 * canonical LFS pointer at a path named by its content
 * (`attachments/<sha256>.<ext>`); paths are portable (NFC, no `.git`
 * component, names legal on Windows and macOS, segments at most 255 bytes);
 * Epicenter owns `.gitattributes`, `.lfsconfig` and `.gitmodules`.
 *
 * Warned only (`lint`): malformed or unresolved conflict blocks, CR in a
 * file that is not a note, a long total path.
 *
 * The server adds what needs the tree: paths equal after NFC and case
 * folding are one path, a blob's path is immutable and its bytes present,
 * and a merge may not grow a note past 1 MB or past `BLOCK_CAP` conflict
 * blocks. An identical block is never written twice (`withBlock`).
 */
import { parsePointer, parses } from '../markdown.js';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
export const LIMIT = 1024 * 1024;

/** Repository control files only Epicenter writes. */
export const CONTROL = new Set(['.gitattributes', '.lfsconfig', '.gitmodules']);
/** What Epicenter writes into `.gitattributes`. */
export const ATTRIBUTES = '*.md text eol=lf\n';

/** A note is a path ending `.md` in any case. */
export const isNote = (path: string) => path.toLowerCase().endsWith('.md');
/** One path's identity: equal after NFC and case folding means the same path. */
export const fold = (path: string) => path.normalize('NFC').toLowerCase();

const ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/;
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const BLOB = /^attachments\/([0-9a-f]{64})\.[a-z0-9]+$/;

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
	if (CONTROL.has((segments.at(-1) ?? '').toLowerCase())) return 'Epicenter owns this file';
	return null;
}

/** Why the repository may not hold `text` at `path` (null deletes), or null when it may. */
export function admissible(path: string, text: string | null): string | null {
	const refusal = pathRefusal(path);
	if (refusal !== null || text === null) return refusal;
	if (text.includes('\0')) return 'binary files go through Git LFS';
	if (LONE_SURROGATE.test(text)) return 'the text is not valid UTF-8';
	const pointer = parsePointer(text);
	if (isNote(path)) {
		if (pointer !== null) return 'a note may not be an LFS pointer';
		if (text.startsWith('\uFEFF')) return 'a note may not start with a byte order mark';
		if (text.includes('\r')) return 'a note must use LF line endings';
		if (bytes(text) > LIMIT) return 'a note may be at most 1 MB';
		if (!parses(text)) return 'does not parse';
		return null;
	}
	if (pointer !== null) return BLOB.exec(path)?.[1] === pointer.oid ? null : "a blob's path must be named by its content";
	if (bytes(text) > LIMIT) return 'a file may be at most 1 MB';
	return null;
}

// ============================================================================
// Conflict blocks: a strict grammar, written escaped, found only when well formed
// ============================================================================

const MARKERS = ['<<<<<<< ', '||||||| ', '=======', '>>>>>>> '];
const isMarker = (line: string) => MARKERS.some((m) => line.startsWith(m)) || line === '=======';

/** A content line that would read as a delimiter (or as an escaped one) gets one more backslash. */
export const escapeLine = (line: string) => (isMarker(line.replace(/^\\+/, '')) ? `\\${line}` : line);
export const escapeLines = (text: string) => text.split('\n').map(escapeLine).join('\n');

/** One labelled block holding `incoming` whole, with its delimiter-like lines escaped. */
export function block({ current, base = '', incoming }: { current: string; base?: string; incoming: string }, labels: { current: string; incoming: string }) {
	const section = (text: string) => (text === '' ? '' : `${escapeLines(text.endsWith('\n') ? text.slice(0, -1) : text)}\n`);
	return `<<<<<<< ${labels.current}\n${section(current)}||||||| base\n${section(base)}=======\n${section(incoming)}>>>>>>> ${labels.incoming}\n`;
}

const unlabelled = (text: string) => text.replace(/^(<<<<<<<|>>>>>>>) .*$/gm, '$1');

/** `text` with `added` (one block) after it, unless a block with the same sections, whoever's labels, is already there. */
export function withBlock(text: string, added: string) {
	if (unlabelled(text).includes(unlabelled(added))) return text;
	return `${text === '' || text.endsWith('\n') ? text : `${text}\n`}${added}`;
}

/** The most conflict blocks a merge may leave in a note; past it the merge is refused (an agent redoes it, a person holds it). */
export const BLOCK_CAP = 20;

/** The well-formed conflict blocks in a text: delimiters in order, labelled, none nested. */
export function findConflicts(text: string) {
	const lines = text.split('\n');
	const found: { line: number; current: string; incoming: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = lines[i] ?? '';
		if (!open.startsWith('<<<<<<< ') || open.length <= 8) continue;
		let base = -1;
		let middle = -1;
		let close = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? '';
			if (line.startsWith('<<<<<<< ')) break;
			if (base < 0 && line === '||||||| base') base = j;
			else if (base >= 0 && middle < 0 && line === '=======') middle = j;
			else if (middle >= 0 && line.startsWith('>>>>>>> ') && line.length > 8) {
				close = j;
				break;
			}
		}
		if (close < 0) continue;
		found.push({ line: i + 1, current: open.slice(8), incoming: (lines[close] ?? '').slice(8) });
		i = close;
	}
	return found;
}

/** Warnings only: nothing here refuses. */
export function lint(path: string, text: string | null): string[] {
	if (text === null) return [];
	const warnings: string[] = [];
	const opens = text.split('\n').filter((line) => line.startsWith('<<<<<<< ')).length;
	const blocks = findConflicts(text).length;
	if (blocks > 0) warnings.push(`${blocks} unresolved conflict block${blocks === 1 ? '' : 's'}`);
	if (opens > blocks) warnings.push('a malformed conflict block');
	if (!isNote(path) && text.includes('\r')) warnings.push('CR line endings');
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
