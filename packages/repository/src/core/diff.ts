/**
 * Text changes between two texts, and the positional rebase an editor uses
 * to carry what a person typed onto a text the worker merged.
 *
 * `diffText` finds lines first (compared without their terminators, so a
 * last line typed without a newline still meets itself inside a conflict
 * block, whose sections end in one) and then characters within each run of
 * changed lines. Its changes are in the first text's positions, sorted, and
 * never overlap.
 */
import { bodyOf } from './markdown.js';
import { diff } from './merge.js';

/** Replace `from` to `to` of a text with `insert`. */
export type TextChange = { from: number; to: number; insert: string };

const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const content = (line: string) => (line.endsWith('\n') ? line.slice(0, -1) : line);

/** The changes that turn `a` into `b`. */
export function diffText(a: string, b: string): TextChange[] {
	if (a === b) return [];
	const left = linesOf(a);
	const right = linesOf(b);
	const at = (lines: string[]) => {
		const offsets = [0];
		for (const line of lines) offsets.push((offsets.at(-1) ?? 0) + line.length);
		return offsets;
	};
	const leftAt = at(left);
	const rightAt = at(right);
	const changes: TextChange[] = [];
	/** Characters within one run of lines, offset to where the run starts. */
	const refine = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
		const x = a.slice(aFrom, aTo);
		const y = b.slice(bFrom, bTo);
		if (x === y) return;
		for (const hunk of diff([...x], [...y])) changes.push({ from: aFrom + hunk.start, to: aFrom + hunk.end, insert: [...y].slice(hunk.sideStart, hunk.sideEnd).join('') });
	};
	let i = 0;
	let j = 0;
	const hunks = diff(left.map(content), right.map(content));
	for (const hunk of [...hunks, { start: left.length, end: left.length, sideStart: right.length, sideEnd: right.length }]) {
		// Lines that match by content: only a terminator can differ.
		for (; i < hunk.start; i++, j++) refine(leftAt[i] ?? 0, leftAt[i + 1] ?? 0, rightAt[j] ?? 0, rightAt[j + 1] ?? 0);
		if (hunk.end > hunk.start || hunk.sideEnd > hunk.sideStart) refine(leftAt[hunk.start] ?? 0, leftAt[hunk.end] ?? 0, rightAt[hunk.sideStart] ?? 0, rightAt[hunk.sideEnd] ?? 0);
		i = hunk.end;
		j = hunk.sideEnd;
	}
	return changes;
}

/** `text` with `changes` (in its positions, sorted, not overlapping) made. */
export function applyChanges(text: string, changes: TextChange[]) {
	let out = '';
	let at = 0;
	for (const change of changes) {
		out += text.slice(at, change.from) + change.insert;
		at = change.to;
	}
	return out + text.slice(at);
}

/** Whether two changes to one text touch the same characters, or one inserts strictly inside what the other replaces. */
const overlaps = (x: TextChange, y: TextChange) => x.from < y.to && y.from < x.to;

/**
 * Carry the typing from `sent` to `draft` onto `merged`, the text the
 * worker made of `sent`, by position: never by merging again, so a
 * conflict block in `merged` is kept as it is and the typing lands where
 * it was made. Where both insert at one point, the typing stays with the
 * line it was typed on: whole lines the worker inserted at the start of a
 * line go before it (a block's opening lines stay whole), anything else
 * the worker inserted there goes after it. Null when the two touch the
 * same characters, which positions alone cannot settle.
 *
 * `typed`, the typing from `sent` to `draft` when the caller knows it (an
 * editor's own change set), places it exactly; the diff of the two finds it
 * otherwise, and with repeated characters may place it on the other side
 * of a worker's insertion.
 *
 * `changes` turn `draft` into the result, for an editor to apply in place
 * so the cursor and the undo history map through them; `typed` in the
 * answer is the typing again, over `merged`.
 */
export function rebase(sent: string, draft: string, merged: string, typed: TextChange[] = diffText(sent, draft)): { text: string; changes: TextChange[]; typed: TextChange[] } | null {
	const worker = diffText(sent, merged);
	for (const x of typed) for (const y of worker) if (overlaps(x, y)) return null;
	const changes: TextChange[] = [];
	const wholeLines = (y: TextChange) => y.from === y.to && (y.from === 0 || sent[y.from - 1] === '\n') && y.insert.endsWith('\n');
	const before = (x: TextChange, y: TextChange) => x.to < y.from || (x.to === y.from && !(x.from === x.to && wholeLines(y)));
	// How far the typing before each change moved it, in the draft's positions.
	let shift = 0;
	let t = 0;
	for (const y of worker) {
		for (let x = typed[t]; x !== undefined && before(x, y); x = typed[++t]) shift += x.insert.length - (x.to - x.from);
		changes.push({ from: y.from + shift, to: y.to + shift, insert: y.insert });
	}
	// The typing again, now over `merged`: each change moved by the worker's changes before it.
	const carried: TextChange[] = [];
	let moved = 0;
	let w = 0;
	for (const x of typed) {
		for (let y = worker[w]; y !== undefined && !before(x, y); y = worker[++w]) moved += y.insert.length - (y.to - y.from);
		carried.push({ from: x.from + moved, to: x.to + moved, insert: x.insert });
	}
	return { text: applyChanges(draft, changes), changes, typed: carried };
}

type Op = { retain: number } | { remove: number } | { insert: string };

/** `changes` over a text of `length` as a run of operations, the text's whole length covered. */
function opsOf(changes: TextChange[], length: number): Op[] {
	const ops: Op[] = [];
	let at = 0;
	for (const change of changes) {
		if (change.from > at) ops.push({ retain: change.from - at });
		if (change.to > change.from) ops.push({ remove: change.to - change.from });
		if (change.insert !== '') ops.push({ insert: change.insert });
		at = change.to;
	}
	if (length > at) ops.push({ retain: length - at });
	return ops;
}

/**
 * The changes `first` then `second` make together: `first` turns a text of
 * `length` into another, and `second` turns that one into a third.
 */
export function composeChanges(first: TextChange[], second: TextChange[], length: number): TextChange[] {
	const a = opsOf(first, length);
	const middle = length + first.reduce((sum, change) => sum + change.insert.length - (change.to - change.from), 0);
	const b = opsOf(second, middle);
	const out: TextChange[] = [];
	let at = 0;
	const edit = (remove: number, insert: string) => {
		const last = out.at(-1);
		if (last !== undefined && last.to === at) {
			last.to += remove;
			last.insert += insert;
		} else out.push({ from: at, to: at + remove, insert });
		at += remove;
	};
	let i = 0;
	let j = 0;
	// What is left of the operation each side is in.
	let x: Op | undefined = a[0];
	let y: Op | undefined = b[0];
	const nextA = () => (x = a[++i]);
	const nextB = () => (y = b[++j]);
	while (x !== undefined || y !== undefined) {
		if (y !== undefined && 'insert' in y) {
			edit(0, y.insert);
			nextB();
		} else if (x !== undefined && 'remove' in x) {
			edit(x.remove, '');
			nextA();
		} else if (x === undefined || y === undefined) break;
		else {
			const xs = 'retain' in x ? x.retain : x.insert.length;
			const ys = 'retain' in y ? y.retain : y.remove;
			const n = Math.min(xs, ys);
			if ('retain' in x && 'retain' in y) at += n;
			else if ('retain' in x) edit(n, '');
			else if ('retain' in y) edit(0, x.insert.slice(0, n));
			// An insertion the second removed is no change at all.
			x = xs > n ? ('retain' in x ? { retain: xs - n } : { insert: x.insert.slice(n) }) : a[++i];
			y = ys > n ? ('retain' in y ? { retain: ys - n } : { remove: ys - n }) : b[++j];
		}
	}
	return out.filter((change) => change.to > change.from || change.insert !== '');
}

/**
 * `changes`, which turn the exact text `before` into `after`, as a view of
 * the body sees them: in the body's positions, the frontmatter's own
 * changes left out. Where a change crosses the frontmatter's edge (a note
 * gaining or losing its header), the two bodies' diff.
 */
export function bodyChanges(before: string, after: string, changes: TextChange[]): TextChange[] {
	const body = bodyOf(before);
	const header = before.length - body.length;
	const moved = changes.filter((change) => change.from >= header).map((change) => ({ from: change.from - header, to: change.to - header, insert: change.insert }));
	const next = bodyOf(after);
	return applyChanges(body, moved) === next ? moved : diffText(body, next);
}
