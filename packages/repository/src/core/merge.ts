/**
 * The Epicenter merge: one pure function that merges a write against its base.
 * The server, devices replaying unsent edits, and the CLI all use it.
 *
 * - Frontmatter merges by key. On a clash the current value wins, except that
 *   a key one side deleted keeps the other side's change, as a file does; no
 *   markers ever go into frontmatter.
 * - The body merges by line, so edits on neighboring lines do not conflict;
 *   lines both sides changed merge again by word, so letters never blend.
 *   Two insertions at one point are both kept, current first.
 * - Two creates at one path merge fields and keep both bodies.
 * - A delete against an edit returns the edit.
 *
 * The text is already settled the people's way, except that body overlaps hold
 * `current`. Every clash is reported in `overlaps`, and `settle` decides what
 * they mean: `withBlocks` writes the body ones as conflict blocks.
 *
 * One clash is one conflict block, however many writes follow it: an edit of
 * lines that a block already offers as one of its sides continues that side,
 * and adds no block (`continuedBlock`; `settle` does the same for a field's
 * block). The server merging a commit onto a moved main, a device replaying
 * unsent work over what arrived, and an editor's write all reach it here.
 */
import { block, findConflicts, type Labels, sideOffering, withSide } from './conflict.js';
import { parseMarkdown, sameValue, splitMarkdown, writeMarkdown } from './markdown.js';

/** Something both sides changed, as the merge found it. */
export type ContentOverlap =
	/**
	 * Lines or words both sides changed. `start` and `end` are offsets in the
	 * merged text, which holds `current` there.
	 */
	| { unit: 'body'; base: string; current: string; incoming: string; start: number; end: number }
	/** The same, where a side's span holds an existing conflict block. */
	| { unit: 'block'; base: string; current: string; incoming: string; start: number; end: number }
	/** A frontmatter key both sides changed. A missing value means the key was absent. */
	| { unit: 'field'; key: string; base?: unknown; current?: unknown; incoming?: unknown }
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
	const b = base === null ? null : parseMarkdown(base);
	const c = parseMarkdown(current);
	const i = parseMarkdown(incoming);
	const created: ContentOverlap[] = base === null && current !== incoming ? [{ unit: 'file', clash: 'created' }] : [];
	// Unparseable frontmatter on any side: merge the whole text as body.
	if (c.error !== null || i.error !== null || b?.error) {
		return finish(bodyParts(base ?? '', current, incoming), created);
	}
	const baseFields = b?.data.fields ?? {};
	const { chosen, clashes } = chooseFields(baseFields, c.data.fields, i.data.fields);
	const parts: Part[] =
		b === null
			? [{ text: joinCreates(c.data.body, i.data.body) }]
			: bodyParts(b.data.body, c.data.body, i.data.body);
	const mergedBody = parts.map((part) => ('text' in part ? part.text : part.overlap.current)).join('');
	const changed: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(c.data.fields), ...Object.keys(chosen)]))
		if (!sameValue(c.data.fields[key], chosen[key])) changed[key] = chosen[key];
	const written = writeMarkdown(current, { fields: changed, body: mergedBody });
	// Current parsed, so writing its own fields back cannot fail.
	if (written.error !== null) return finish(bodyParts(base ?? '', current, incoming), created);
	const header = written.data.slice(0, splitMarkdown(written.data).bodyStart);
	return finish(parts, [...created, ...clashes], header);
}

function chooseFields(
	base: Record<string, unknown>,
	current: Record<string, unknown>,
	incoming: Record<string, unknown>,
) {
	const chosen: Record<string, unknown> = {};
	const clashes: ContentOverlap[] = [];
	for (const key of new Set([...Object.keys(current), ...Object.keys(incoming), ...Object.keys(base)])) {
		const b = base[key];
		const c = current[key];
		const i = incoming[key];
		let value: unknown;
		if (sameValue(c, i) || sameValue(i, b)) value = c;
		else if (sameValue(c, b)) value = i;
		else {
			// Both changed it: current wins, but a delete loses to an edit it had not seen.
			value = c === undefined ? i : c;
			clashes.push({
				unit: 'field',
				key,
				...(b === undefined ? {} : { base: b }),
				...(c === undefined ? {} : { current: c }),
				...(i === undefined ? {} : { incoming: i }),
			});
		}
		if (value !== undefined) chosen[key] = value;
	}
	return { chosen, clashes };
}

/** Two creates at one path keep both bodies, current first, a blank line apart. */
function joinCreates(current: string, incoming: string) {
	if (current === incoming || incoming.trim() === '') return current;
	if (current.trim() === '') return incoming;
	return `${current.replace(/\n+$/, '')}\n\n${incoming.replace(/^\n+/, '')}`;
}

type Part = { text: string } | { overlap: { base: string; current: string; incoming: string } };

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
	for (const part of mergeSequence(lines(base), lines(current), lines(incoming), { lines: true })) {
		if ('text' in part) {
			parts.push(part);
			continue;
		}
		const { overlap } = part;
		// Marker blocks stay atomic: never split, so never nested.
		if ([overlap.base, overlap.current, overlap.incoming].some(hasBlock)) {
			parts.push(part);
			continue;
		}
		parts.push(...mergeSequence(words(overlap.base), words(overlap.current), words(overlap.incoming)));
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
	type Group = { start: number; end: number; edits: SourcedHunk[] };
	const groups: Group[] = [];
	for (const hunk of edits) {
		const group = groups.at(-1);
		// Shared boundaries are independent; insertions at one point group together.
		const joins =
			group !== undefined &&
			(hunk.start < group.end ||
				(hunk.start === group.start && hunk.end === hunk.start && group.end === group.start));
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
			parts.push({ text: [...ended, ...i].join('') });
		}
		else parts.push({ overlap: { base: b.join(''), current: c.join(''), incoming: i.join('') } });
		at = group.end;
	}
	if (at < base.length) parts.push({ text: base.slice(at).join('') });
	return parts;
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

/** The prototype's LCS table walk, over one region. */
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
	for (let i = n - 1; i >= 0; i--) {
		const row = table[i];
		if (row === undefined) continue;
		for (let j = m - 1; j >= 0; j--)
			row[j] = base[aLo + i] === side[bLo + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
	}
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (base[aLo + i] === side[bLo + j]) {
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
