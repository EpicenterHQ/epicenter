/**
 * Plain text read off a note's node, without rebuilding the note.
 *
 * A note's body is a nested `Y.Node` in the document this store already holds
 * (ADR-0295), so the list can read what it needs directly. It used to read a
 * `preview` value the editor wrote back on every change, because a body lived
 * in its own lazily loaded document (ADR-0248) and a list could not afford to
 * open one per row. That reason is gone.
 *
 * **Everything here goes through `slice`, and that is the whole point.**
 * `YNode.slice` walks the item list and returns as soon as it has the count it
 * was asked for (`typeListSlice`, `@y/y` 14.0.0-rc.26 `src/ynode.js`), so
 * reading a hundred characters costs a hundred characters. `toString`,
 * `toArray`, `forEach`, `map` and `toJSON` all route through `toDelta` and
 * materialize the entire subtree, so `body.toString().slice(0, 100)` would pay
 * the cost of the whole note on every render. It looks like the obvious
 * spelling and it is the expensive one.
 *
 * `slice` yields a text run as a plain string and a nested element as a
 * `Y.Node`, which is the same discriminant `toString` uses internally, so
 * walking it needs nothing from ProseMirror.
 */
import * as Y from '@y/y';

/** How many children to ask for at once while filling a budget. */
const BATCH = 8;

/**
 * Plain text from the start of one node, up to `limit` characters.
 *
 * A string child is text. A `Y.Node` child is an element whose own children
 * are walked the same way; for a text-bearing type those children are single
 * characters, which is what `ContentString.getContent` hands back.
 */
function textOf(node: unknown, limit: number): string {
	if (limit <= 0) return '';
	if (typeof node === 'string') return node.slice(0, limit);
	if (!(node instanceof Y.Node)) return '';
	let text = '';
	let taken = 0;
	while (text.length < limit && taken < node.length) {
		const batch = node.slice(taken, Math.min(taken + BATCH, node.length));
		if (batch.length === 0) break;
		for (const child of batch) {
			text += textOf(child, limit - text.length);
			if (text.length >= limit) break;
		}
		taken += batch.length;
	}
	return text;
}

/**
 * A note's title: the text of its first block, as the person typed it.
 *
 * Still derived rather than authored, because Honeycrisp's editor is one
 * surface and the title is the first line of it. The cap matches what the row
 * used to store.
 */
export function noteTitle(body: Y.Node): string {
	return textOf(body.slice(0, 1)[0], 80).trim();
}

/**
 * A note's preview: the first hundred characters of its text.
 *
 * Blocks are joined with a space so the last word of one does not run into the
 * first word of the next. Not stored anywhere; the list reads it.
 */
export function notePreview(body: Y.Node): string {
	const limit = 100;
	const parts: string[] = [];
	let length = 0;
	let taken = 0;
	while (length < limit && taken < body.length) {
		const batch = body.slice(taken, Math.min(taken + BATCH, body.length));
		if (batch.length === 0) break;
		for (const block of batch) {
			const text = textOf(block, limit - length);
			if (text !== '') {
				parts.push(text);
				length += text.length + 1;
			}
			if (length >= limit) break;
		}
		taken += batch.length;
	}
	return parts.join(' ').slice(0, limit).trim();
}
