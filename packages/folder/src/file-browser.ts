/** How a file browser opens a file's bytes as an editor, and keeps its newlines. */

export type OpenedFile =
	/** The file's exact text, decoded from its whole bytes. */
	| { kind: 'text'; text: string }
	| { kind: 'binary'; size: number }
	| { kind: 'tooLarge'; size: number };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** How large a file opens as text by default: 1 MiB. */
const EDITABLE_TEXT_BYTES = 1024 * 1024;

/**
 * A file's bytes as an editor opens them. Only valid UTF-8 without NUL
 * bytes, and no larger than `maxBytes`, opens as text, and the decoded text
 * keeps a byte order mark so a write sends the same bytes back.
 */
export function openedFile(
	bytes: Uint8Array,
	maxBytes = EDITABLE_TEXT_BYTES,
): OpenedFile {
	if (bytes.byteLength > maxBytes)
		return { kind: 'tooLarge', size: bytes.byteLength };
	if (bytes.includes(0)) return { kind: 'binary', size: bytes.byteLength };
	try {
		return { kind: 'text', text: utf8.decode(bytes) };
	} catch {
		return { kind: 'binary', size: bytes.byteLength };
	}
}

/** Textareas report LF; keep the file's CRLF line endings when it uses them. */
export function withFileNewlines(text: string, reference: string): string {
	return reference.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}
