/**
 * Which read of a folder answered a value. A folder handle notes, on each
 * row and file content its reads answer, its own commit count when the read
 * started; the edit owner shows a view its own saves that landed after that.
 *
 * A note is written once, when the read answers a new value, and never
 * changes: a value keeps the read it came from for as long as it lives. A
 * value derived from one read's value alone, such as its decoded bytes,
 * carries that read only through `carryRead`, as `fileBytes` does. No value
 * is matched to a read by equal content, and a newer read never relabels an
 * older value, so a view keeps the read it was actually given. A cache that
 * keeps an older value in place of an equal newer one (structural sharing)
 * would show a view the older read; source-bearing queries turn it off.
 */

type Note = { readonly folder: object; readonly read: number };

const notes = new WeakMap<object, Note>();

/**
 * Note that `folder` answered `value`, a value its read just made, from a
 * read started at commit count `read`. A value already noted keeps its note.
 */
export function noteRead(value: object, folder: object, read: number) {
	if (!notes.has(value)) notes.set(value, { folder, read });
}

/** The commit count when `folder`'s read of `value` started, or -1 when none of its reads answered it. */
export function readOf(value: object | undefined, folder: object): number {
	if (value === undefined) return -1;
	const note = notes.get(value);
	return note?.folder === folder ? note.read : -1;
}

/** Give `to`, a new value derived from `from` alone, the read `from` came from. */
export function carryRead(from: object, to: object) {
	const note = notes.get(from);
	if (note !== undefined && !notes.has(to)) notes.set(to, note);
}

const rowContents = new WeakMap<object, Uint8Array>();

/**
 * The exact bytes of `row`'s source text, carrying the read that answered
 * the row, for a whole-text edit of a row's file. The same row answers the
 * same bytes.
 */
export function rowBytes(row: { readonly text: string }): Uint8Array {
	let bytes = rowContents.get(row);
	if (bytes === undefined) {
		bytes = new TextEncoder().encode(row.text);
		carryRead(row, bytes);
		rowContents.set(row, bytes);
	}
	return bytes;
}

/**
 * The bytes of `content`, a file a folder read answered, carrying that read.
 * Decode a read's content with this when a view's bytes are the source an
 * edit names.
 */
export async function fileBytes(content: Blob): Promise<Uint8Array> {
	const bytes = new Uint8Array(await content.arrayBuffer());
	carryRead(content, bytes);
	return bytes;
}
