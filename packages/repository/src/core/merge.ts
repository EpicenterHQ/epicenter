/**
 * The Epicenter merge: one pure function that merges a write against its base.
 * The server, devices replaying unsent edits, and the CLI all use it.
 *
 * A note is a header and a body: the header is the fenced block at the very
 * top when it parses; otherwise there is none and the whole text is body.
 * Each merges by its kind, and the text is written from the merged structure.
 *
 * - The header merges by top-level key, each value whole. A key both sides
 *   changed takes the later write's value: `incoming` (the write arriving
 *   now, in the server's order) over `current` (what `main` holds). A key
 *   one side deleted keeps the other side's change, as a file does. It is
 *   written in house style from current's document, so its comments stay.
 *   No markers ever go into the header.
 * - The body merges by line, so edits on neighboring lines do not conflict;
 *   lines both sides changed merge again by word, so letters never blend.
 *   Two insertions at one point are both kept, current first.
 * - Two creates at one path merge fields and keep both bodies.
 * - A delete against an edit returns the edit.
 *
 * The text is already settled the people's way, except that body overlaps hold
 * `current`. Every clash is reported in `overlaps`, and `settle` decides what
 * they mean: `withBlocks` writes the body ones as conflict blocks. A header
 * key is never a clash.
 *
 * One clash is one conflict block, however many writes follow it: an edit of
 * lines that a block already offers as one of its sides continues that side,
 * and adds no block (`continuedBlock`). The server merging a commit onto a
 * moved main, a device replaying unsent work over what arrived, and an
 * editor's write all reach it here.
 */
import { Document, isMap, isNode, isScalar, type Pair, type YAMLMap } from 'yaml';
import { block, findConflicts, type Labels, sideOffering, withSide } from './conflict.js';
import { emptyHeaderFor, houseHeader, plainHeader, readNote, sameValue } from './markdown.js';

/** Something both sides changed, as the merge found it. */
export type ContentOverlap =
	/**
	 * Lines or words both sides changed. `start` and `end` are offsets in the
	 * merged text, which holds `current` there.
	 */
	| { unit: 'body'; base: string; current: string; incoming: string; start: number; end: number }
	/** The same, where a side's span holds an existing conflict block. */
	| { unit: 'block'; base: string; current: string; incoming: string; start: number; end: number }
	/** One side deleted the file and the other edited it. */
	| { unit: 'file'; clash: 'deleted'; side: 'current' | 'incoming' }
	/** Both sides created the file. */
	| { unit: 'file'; clash: 'created' };

export type MergeResult = {
	/** The merged text; null when the file ends up deleted. */
	text: string | null;
	overlaps: ContentOverlap[];
};

const lf = (text: string) => text.replaceAll('\r\n', '\n');
const styled = (text: string, current: string | null) =>
	current?.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text;
const same = (a: string[], b: string[]) =>
	a.length === b.length && a.every((item, index) => item === b[index]);
const clean = (text: string | null): MergeResult => ({ text, overlaps: [] });
type SpanOverlap = Extract<ContentOverlap, { unit: 'body' | 'block' }>;
const isSpan = (overlap: ContentOverlap): overlap is SpanOverlap => overlap.unit === 'body' || overlap.unit === 'block';

/**
 * Merge `incoming` into `current`, both descended from `base`. null means no
 * file: a null base is a create, a null side is a delete.
 */
export function merge(
	base: string | null,
	current: string | null,
	incoming: string | null,
): MergeResult {
	if (current === incoming) return clean(current);
	if (base !== null && incoming === base) return clean(current);
	if (base !== null && current === base)
		return clean(incoming === null ? null : styled(lf(incoming), current));
	if (base === null && (current === null || incoming === null))
		return clean(current ?? incoming);
	if (current === null || incoming === null)
		return {
			text: current ?? incoming,
			overlaps: [{ unit: 'file', clash: 'deleted', side: current === null ? 'current' : 'incoming' }],
		};

	const result = markdown(base === null ? null : lf(base), lf(current), lf(incoming));
	if (!current.includes('\r\n')) return result;
	// Restore current's line endings and move offsets past the added CRs.
	const merged = result.text ?? '';
	const crsBefore = (offset: number) => merged.slice(0, offset).match(/\n/g)?.length ?? 0;
	return {
		...result,
		text: styled(merged, current),
		overlaps: result.overlaps.map((overlap) =>
			isSpan(overlap)
				? {
						...overlap,
						start: overlap.start + crsBefore(overlap.start),
						end: overlap.end + crsBefore(overlap.end),
						base: styled(overlap.base, current),
						current: styled(overlap.current, current),
						incoming: styled(overlap.incoming, current),
					}
				: overlap,
		),
	};
}

function markdown(base: string | null, current: string, incoming: string): MergeResult {
	const created: ContentOverlap[] = base === null && current !== incoming ? [{ unit: 'file', clash: 'created' }] : [];
	const b = base === null ? null : readNote(base);
	const c = readNote(current);
	const i = readNote(incoming);
	const fields = mergeFields(b?.fields ?? {}, c.fields, i.fields);
	const parts: Part[] = b === null ? [{ text: joinCreates(c.body, i.body) }] : bodyParts(b.body, c.body, i.body);
	const body = parts.map((part) => ('text' in part ? part.text : part.overlap.current)).join('');
	// Whether there is a header at all merges as a value does: a side that dropped its header (or broke it, so its block is body) drops it.
	const [had, has, sent] = [b !== null && b.document !== null, c.document !== null, i.document !== null];
	const headed = Object.keys(fields).length > 0 || (has === had ? sent : has);
	return finish(parts, created, headed ? headerFor(c, i, fields) : emptyHeaderFor(body));
}

// ============================================================================
// Header: by top-level key, each value whole, the later write winning a key
// ============================================================================

type Fields = Record<string, unknown>;

/**
 * RULE: the header merges by top-level key, each value whole (a map or a
 * list is one value). A key one side changed takes that side's value. A
 * key both sides changed takes the later write's: `incoming`, the write
 * arriving now in the server's order, over `current`, what `main` holds
 * (never a device clock). A delete still loses to an edit it had not seen,
 * as a file's does. No clash is reported and no block is written: the value
 * that lost stays in history. A side or base with no header has no keys, so
 * what the other added is added.
 */
function mergeFields(base: Fields, current: Fields, incoming: Fields): Fields {
	const merged: Fields = {};
	for (const key of new Set([...Object.keys(current), ...Object.keys(incoming), ...Object.keys(base)])) {
		const [b, c, i] = [base[key], current[key], incoming[key]];
		let value: unknown;
		if (sameValue(c, i) || sameValue(i, b)) value = c;
		else if (sameValue(c, b)) value = i;
		// Both changed it: the later write, incoming, wins; its delete loses to an edit it had not seen.
		else value = i === undefined ? c : i;
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

/**
 * The merged header in house style: current's document (or incoming's,
 * where current has none) with each key's value set to the merged one, so
 * comments, key order and quoting stay. A key keeps its own pair, and a
 * value taken from incoming is incoming's node, its comments with it; a key
 * only incoming has is incoming's pair, appended.
 */
function headerFor(current: Note, incoming: Note, fields: Fields) {
	const document = current.document ?? incoming.document ?? new Document();
	const sides = [current.document, incoming.document].filter((side) => side !== null);
	const map = isMap(document.contents) ? document.contents : (document.createNode({}) as YAMLMap);
	const keys = new Set([...map.items.map(keyOf).filter((key) => Object.hasOwn(fields, key)), ...Object.keys(fields)]);
	/** The side's pair for `key` whose value reads as the merged one, in `document` (copied, if it is another's). */
	const pairFrom = (key: string) => {
		for (const side of sides) {
			const pair = pairIn(side.contents, key);
			if (pair !== undefined && sameValue(valueOf(pair.value, side), fields[key])) return side === document ? pair : pair.clone();
		}
		return document.createPair(key, fields[key], PLAIN);
	};
	map.items = [...keys].map((key) => {
		const own = pairIn(map, key);
		if (own === undefined) return pairFrom(key);
		if (!sameValue(valueOf(own.value, document), fields[key])) own.value = pairFrom(key).value;
		return own;
	});
	if (map.items.length > 0 || isMap(document.contents)) document.contents = map;
	return houseHeader(document, fields) ?? plainHeader(fields);
}

type Note = ReturnType<typeof readNote>;
const valueOf = (node: unknown, document: Document): unknown => {
	if (!isNode(node)) return node === null ? null : undefined;
	try {
		return node.toJS(document);
	} catch {
		return undefined;
	}
};
const keyOf = (pair: Pair) => String(isScalar(pair.key) ? pair.key.value : pair.key);
const pairIn = (node: unknown, key: string) => (isMap(node) ? node.items.find((pair) => keyOf(pair) === key) : undefined);

/** Values are written out in full: an alias would break when its anchor's key is removed. */
const PLAIN = { aliasDuplicateObjects: false } as const;

/** Two creates at one path keep both bodies, current first, a blank line apart. */
function joinCreates(current: string, incoming: string) {
	if (current === incoming || incoming.trim() === '') return current;
	if (current.trim() === '') return incoming;
	return `${current.replace(/\n+$/, '')}\n\n${incoming.replace(/^\n+/, '')}`;
}

/** A merged run, or a clash; `whole`: a clash of lines both sides moved there, never merged again by word. */
type Part = { text: string } | { overlap: { base: string; current: string; incoming: string }; whole?: true };

function finish(parts: Part[], fields: ContentOverlap[], header = ''): MergeResult {
	let text = header;
	const overlaps: ContentOverlap[] = [...fields];
	for (const part of parts) {
		if ('text' in part) {
			text += part.text;
			continue;
		}
		const start = text.length;
		text += part.overlap.current;
		const { base, current, incoming } = part.overlap;
		const unit = [base, current, incoming].some(hasBlock) ? 'block' : 'body';
		overlaps.push({ unit, base, current, incoming, start, end: text.length });
	}
	return { text, overlaps };
}

// ============================================================================
// Body: lines, then words within lines both sides changed
// ============================================================================

/** Lines with their terminators; an existing marker block is one atomic line. */
function lines(text: string) {
	const raw = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const out: string[] = [];
	for (let index = 0; index < raw.length; index++) {
		const line = raw[index] ?? '';
		if (!line.startsWith('<<<<<<< ')) {
			out.push(line);
			continue;
		}
		let end = index + 1;
		while (end < raw.length && !(raw[end] ?? '').startsWith('>>>>>>> ')) end++;
		if (end === raw.length) out.push(line);
		else {
			out.push(raw.slice(index, end + 1).join(''));
			index = end;
		}
	}
	return out;
}

const words = (text: string) => text.match(/\S+|\s+/g) ?? [];
const hasBlock = (text: string) => text.includes('<<<<<<< ');

/** A span's plain lines, and the conflict blocks in it, each whole. */
function splitBlocks(text: string) {
	const plain: string[] = [];
	const blocks: string[] = [];
	for (const line of lines(text)) (line.startsWith('<<<<<<< ') && line.includes('\n>>>>>>> ') ? blocks : plain).push(line);
	return { plain: plain.join(''), blocks };
}

function bodyParts(base: string, current: string, incoming: string): Part[] {
	const parts: Part[] = [];
	/** The line-level part emitted last ends mid-line: a side's last line, unterminated at the end of its file. */
	let open = false;
	for (const part of mergeSequence(lines(base), lines(current), lines(incoming), { lines: true })) {
		const { overlap } = 'text' in part ? { overlap: null } : part;
		// Marker blocks stay atomic: never split, so never nested.
		const emitted = overlap === null || ('whole' in part && part.whole) || [overlap.base, overlap.current, overlap.incoming].some(hasBlock) ? [part] : mergeSequence(words(overlap.base), words(overlap.current), words(overlap.incoming));
		const content = emitted.map((p) => ('text' in p ? p.text : p.overlap.current)).join('');
		// RULE: two lines never become one: a part that follows a line one side left unterminated starts on a line of its own.
		if (open && content !== '') parts.push({ text: '\n' });
		parts.push(...emitted);
		const last = emitted.at(-1);
		if (content !== '') open = last !== undefined && 'text' in last && !last.text.endsWith('\n');
	}
	return parts;
}

/** One run of `base` (`start` to `end`) that `side` replaces with its own run (`sideStart` to `sideEnd`). */
export type Hunk = { start: number; end: number; sideStart: number; sideEnd: number };
type SourcedHunk = Hunk & { source: 'current' | 'incoming' };

/** Merge two edits of `base`, as lines (each with its terminator) or as words. */
function mergeSequence(base: string[], current: string[], incoming: string[], { lines = false } = {}): Part[] {
	const edits: SourcedHunk[] = [
		...diff(base, current).map((h) => ({ ...h, source: 'current' as const })),
		...diff(base, incoming).map((h) => ({ ...h, source: 'incoming' as const })),
	].sort((a, b) => a.start - b.start || a.end - b.end);
	type Group = { start: number; end: number; edits: SourcedHunk[]; shared?: true };
	const groups: Group[] = [];
	/** The lines a hunk writes, as its side has them. */
	const written = (hunk: SourcedHunk) => (hunk.source === 'current' ? current : incoming).slice(hunk.sideStart, hunk.sideEnd);
	/** Whether two hunks write a line in common that the base they replace does not have (lines both moved there), blank lines aside. */
	const share = (a: SourcedHunk, b: SourcedHunk) => {
		const had = new Set(base.slice(Math.min(a.start, b.start), Math.max(a.end, b.end)).map((line) => line.replace(/\n$/, '')));
		const mine = new Set(written(a).filter((line) => line.trim() !== '' && !had.has(line.replace(/\n$/, ''))));
		return written(b).some((line) => mine.has(line));
	};
	for (const hunk of edits) {
		const group = groups.at(-1);
		// Shared boundaries are independent; insertions at one point group together.
		// As lines, two sides' hunks that overlap or touch and write a line in common (both moved the same lines there) are one clash, kept whole.
		const moved = lines && group !== undefined && hunk.start <= group.end && group.edits.some((other) => other.source !== hunk.source && share(other, hunk));
		const joins =
			group !== undefined &&
			(hunk.start < group.end || (hunk.start === group.start && hunk.end === hunk.start && group.end === group.start) || moved);
		if (joins && moved) group.shared = true;
		if (joins) {
			group.end = Math.max(group.end, hunk.end);
			group.edits.push(hunk);
		} else groups.push({ start: hunk.start, end: hunk.end, edits: [hunk] });
	}
	const sideFor = (group: Group, source: SourcedHunk['source'], side: string[]) => {
		const out: string[] = [];
		let at = group.start;
		for (const hunk of group.edits.filter((h) => h.source === source)) {
			out.push(...base.slice(at, hunk.start), ...side.slice(hunk.sideStart, hunk.sideEnd));
			at = hunk.end;
		}
		out.push(...base.slice(at, group.end));
		return out;
	};
	const parts: Part[] = [];
	let at = 0;
	for (const group of groups) {
		if (at < group.start) parts.push({ text: base.slice(at, group.start).join('') });
		const b = base.slice(group.start, group.end);
		const c = sideFor(group, 'current', current);
		const i = sideFor(group, 'incoming', incoming);
		const sources = new Set(group.edits.map((h) => h.source));
		if (sources.size === 1 || same(c, i)) parts.push({ text: (sources.has('current') ? c : i).join('') });
		else if (b.length === 0 && group.edits.every((h) => h.start === h.end)) {
			// Both inserted at one point (identical insertions were deduplicated above). RULE: as lines, current's last line ends before incoming's begins: one unterminated (only at the end of a file) is terminated, so two lines never become one.
			const last = c.at(-1);
			const ended = lines && last !== undefined && !last.endsWith('\n') ? [...c.slice(0, -1), `${last}\n`] : c;
			parts.push({ text: (lines ? interleave(ended, i) : [...ended, ...i]).join('') });
		}
		else parts.push({ overlap: { base: b.join(''), current: c.join(''), incoming: i.join('') }, ...(group.shared ? { whole: true as const } : {}) });
		at = group.end;
	}
	if (at < base.length) parts.push({ text: base.slice(at).join('') });
	return parts;
}

/**
 * RULE: two different insertions of lines at one point, aligned against
 * each other: lines both inserted are kept once, and where they differ,
 * current's lines come before incoming's. Two people pasting overlapping
 * text, or both moving the same lines (a frontmatter both broke), keep
 * one copy of what they share.
 */
function interleave(current: string[], incoming: string[]): string[] {
	const out: string[] = [];
	let at = 0;
	for (const hunk of diff(current, incoming)) {
		out.push(...current.slice(at, hunk.end), ...incoming.slice(hunk.sideStart, hunk.sideEnd));
		at = hunk.end;
	}
	out.push(...current.slice(at));
	return out;
}

/** Above this many table cells a region is diffed by unique-line anchors instead. */
const TABLE_LIMIT = 1_000_000;

/**
 * Hunks turning `base` into `side`. Common prefix and suffix are trimmed, small
 * regions use an LCS table, and large regions are split at lines unique to
 * both sides (patience diff), so memory stays bounded for large notes; a large
 * region with no anchor becomes one replacement hunk.
 */
export function diff(base: string[], side: string[]): Hunk[] {
	const matches: [number, number][] = [];
	matchRegion(base, side, 0, base.length, 0, side.length, matches);
	const hunks: Hunk[] = [];
	let a = 0;
	let b = 0;
	for (const [i, j] of [...matches, [base.length, side.length] as [number, number]]) {
		if (i > a || j > b) hunks.push({ start: a, end: i, sideStart: b, sideEnd: j });
		a = i + 1;
		b = j + 1;
	}
	return hunks;
}

function matchRegion(
	base: string[],
	side: string[],
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
	out: [number, number][],
) {
	while (aLo < aHi && bLo < bHi && base[aLo] === side[bLo]) out.push([aLo++, bLo++]);
	const tail: [number, number][] = [];
	while (aLo < aHi && bLo < bHi && base[aHi - 1] === side[bHi - 1]) tail.unshift([--aHi, --bHi]);
	const n = aHi - aLo;
	const m = bHi - bLo;
	if (n > 0 && m > 0) {
		if ((n + 1) * (m + 1) <= TABLE_LIMIT) tableMatches(base, side, aLo, aHi, bLo, bHi, out);
		else {
			const anchors = uniqueAnchors(base, side, aLo, aHi, bLo, bHi);
			let a = aLo;
			let b = bLo;
			for (const [i, j] of anchors) {
				matchRegion(base, side, a, i, b, j, out);
				out.push([i, j]);
				a = i + 1;
				b = j + 1;
			}
			if (anchors.length > 0) matchRegion(base, side, a, aHi, b, bHi, out);
		}
	}
	out.push(...tail);
}

/**
 * The prototype's LCS table walk, over one region, weighted: a match of
 * whitespace counts less than a match of anything else. RULE: where a side
 * could match a word or the space beside it, it matches the word, so two
 * sides keeping one word anchor on that word and neither inserts it again.
 */
function tableMatches(
	base: string[],
	side: string[],
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
	out: [number, number][],
) {
	const n = aHi - aLo;
	const m = bHi - bLo;
	const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	const at = (i: number, j: number) => table[i]?.[j] ?? 0;
	const weight = (token: string) => (token.trim() === '' ? 1 : 2);
	for (let i = n - 1; i >= 0; i--) {
		const row = table[i];
		if (row === undefined) continue;
		for (let j = m - 1; j >= 0; j--) {
			const token = base[aLo + i] ?? '';
			const skip = Math.max(at(i + 1, j), at(i, j + 1));
			row[j] = token === side[bLo + j] ? Math.max(at(i + 1, j + 1) + weight(token), skip) : skip;
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		const token = base[aLo + i] ?? '';
		if (token === side[bLo + j] && at(i, j) === at(i + 1, j + 1) + weight(token)) {
			out.push([aLo + i, bLo + j]);
			i++;
			j++;
		} else if (at(i, j + 1) >= at(i + 1, j)) j++;
		else i++;
	}
}

/** Lines occurring once on each side, in the longest order-preserving chain. */
function uniqueAnchors(
	base: string[],
	side: string[],
	aLo: number,
	aHi: number,
	bLo: number,
	bHi: number,
): [number, number][] {
	const count = (items: string[], lo: number, hi: number) => {
		const seen = new Map<string, number>();
		for (let k = lo; k < hi; k++) {
			const item = items[k] ?? '';
			seen.set(item, seen.has(item) ? -1 : k);
		}
		return seen;
	};
	const inBase = count(base, aLo, aHi);
	const inSide = count(side, bLo, bHi);
	const pairs: [number, number][] = [];
	for (const [line, i] of inBase) {
		const j = inSide.get(line);
		if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
	}
	pairs.sort((x, y) => x[0] - y[0]);
	// Longest increasing subsequence on side positions (patience sorting).
	const tails: number[] = [];
	const previous: number[] = new Array(pairs.length).fill(-1);
	for (const [index, [, j]] of pairs.entries()) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((pairs[tails[mid] ?? 0]?.[1] ?? 0) < j) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) previous[index] = tails[lo - 1] ?? -1;
		tails[lo] = index;
	}
	const chain: [number, number][] = [];
	for (let k = tails.at(-1) ?? -1; k >= 0; k = previous[k] ?? -1) {
		const pair = pairs[k];
		if (pair !== undefined) chain.unshift(pair);
	}
	return chain;
}

// ============================================================================
// Conflict blocks for body overlaps
// ============================================================================

/**
 * One clash is one conflict block, however many writes follow it. Where one
 * side's span is a single block offering the base's lines as one of its
 * sides, that block already is this clash: the other side, which edited
 * those lines, continues that side of it (relabelled as its writer's), and
 * no block of its own is written. Null where the span is not that.
 */
function continuedBlock(base: string, current: string, incoming: string, labels: Labels): string | null {
	if (hasBlock(base)) return null;
	for (const [held, edit, by] of [
		[current, incoming, labels.incoming],
		[incoming, current, labels.current],
	] as const) {
		if (hasBlock(edit)) continue;
		const found = findConflicts(held);
		const conflict = found[0];
		if (found.length !== 1 || conflict === undefined || conflict.raw !== held) continue;
		const side = sideOffering(conflict, base);
		if (side !== null) return withSide(conflict, side, edit, by);
	}
	return null;
}

/**
 * Write each body overlap as a conflict block (core/conflict), current
 * (earlier in server order) first, with a base section.
 *
 * Blocks never nest. An overlap that continues a block's side updates that
 * block (`continuedBlock`). Any other overlap whose span holds an existing
 * block keeps that block whole and writes the plain lines both sides changed
 * as a separate block next to it, followed by any block only incoming had,
 * so neither side is lost. A CRLF text is written with LF blocks inside and its line endings
 * restored after.
 */
export function withBlocks(result: MergeResult, labels: Labels): string | null {
	if (result.text === null) return null;
	const crlf = result.text.includes('\r\n');
	const crsBefore = (offset: number) => result.text?.slice(0, offset).match(/\r\n/g)?.length ?? 0;
	const text = crlf ? lf(result.text) : result.text;
	const terminated = (part: string) => (part !== '' && !part.endsWith('\n') ? `${part}\n` : part);
	let out = '';
	let at = 0;
	for (const overlap of result.overlaps) {
		if (!isSpan(overlap)) continue;
		const start = crlf ? overlap.start - crsBefore(overlap.start) : overlap.start;
		const end = crlf ? overlap.end - crsBefore(overlap.end) : overlap.end;
		const [base, current, incoming] = [overlap.base, overlap.current, overlap.incoming].map(lf) as [string, string, string];
		out += text.slice(at, start);
		if (out !== '' && !out.endsWith('\n')) out += '\n';
		if (overlap.unit === 'block') {
			const continued = continuedBlock(base, current, incoming, labels);
			if (continued !== null) {
				out += continued;
				at = end;
				continue;
			}
			const mine = splitBlocks(current);
			const theirs = splitBlocks(incoming);
			out +=
				mine.plain === theirs.plain
					? terminated(mine.plain)
					: block({ current: mine.plain, base: splitBlocks(base).plain, incoming: theirs.plain }, labels);
			for (const existing of [...mine.blocks, ...theirs.blocks.filter((b) => !mine.blocks.includes(b))]) out += terminated(existing);
			at = end;
			continue;
		}
		out += block({ current, base, incoming }, labels);
		// A block around an inline span takes the line's old terminator.
		at = !current.endsWith('\n') && text.startsWith('\n', end) ? end + 1 : end;
	}
	out += text.slice(at);
	return crlf ? out.replaceAll('\n', '\r\n') : out;
}
