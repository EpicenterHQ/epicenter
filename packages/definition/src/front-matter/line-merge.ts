/**
 * Git's three-way line merge, as `git merge` and libgit2's `merge_file`
 * write it: xdiff's `xdl_merge` at its `ZEALOUS` level, over xdiff's Myers
 * diff with no indent heuristic, conflict style `merge`, seven-character
 * markers labelled `current` and `incoming` (ADR-0795).
 *
 * This is a port, not a reimplementation: the record classes, trimming and
 * discarding of unmatched lines (`prepare`), the divide-and-conquer diff
 * (`split`), the sliding of changed groups (`compact`), and the merge with
 * its conflict refinement follow `xdiff/xprepare.c`, `xdiffi.c` and
 * `xmerge.c` step for step, so a Rust twin can call libgit2 and get the
 * same bytes (`fixtures/front-matter.json` holds them to it).
 *
 * Two departures, both outside what a note's body reaches in practice:
 * - xdiff gives up on a minimal diff once an edit costs more than 256 lines
 *   and takes a heuristic split; this always finds the minimal one. Bodies
 *   that far apart still merge to a correct result, but its alignment may
 *   differ from Git's.
 * - `git merge-file` (the command) merges at `ZEALOUS_ALNUM`, which also
 *   joins two conflicts separated only by lines with no letter or digit;
 *   `git merge` and libgit2 do not, and neither does this.
 */

/** The merged text, and whether it holds a conflict. */
export type LineMerge = { text: string; conflict: boolean };

const MARKER_SIZE = 7;
const CURRENT = 'current';
const INCOMING = 'incoming';

/** xdiff's limits (`xdiff/xdiffi.c`, `xprepare.c`). */
const MAX_EQLIMIT = 1024;
const SIMSCAN_WINDOW = 100;
const KPDIS_RUN = 4;
const LINE_MAX = 0x7fffffff;

/**
 * Merge `current` and `incoming`, both descended from `base`, by lines.
 * Lines both sides changed differently become one conflict block:
 * `<<<<<<< current`, current's lines, `=======`, incoming's lines,
 * `>>>>>>> incoming`.
 */
export function mergeLines(
	base: string,
	current: string,
	incoming: string,
): LineMerge {
	const classes = new Map<string, number>();
	const counts: [number[], number[], number[]] = [[], [], []];
	const records = (text: string, file: 0 | 1 | 2) => {
		const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
		const ids = lines.map((line) => {
			let id = classes.get(line);
			if (id === undefined) {
				id = classes.size;
				classes.set(line, id);
			}
			counts[file][id] = (counts[file][id] ?? 0) + 1;
			return id;
		});
		return { lines, ids };
	};
	const o = records(base, 0);
	const a = records(current, 1);
	const b = records(incoming, 2);

	// Each side against the base; `counts` makes xdiff's per-pair classifier.
	const ours = diff(o.ids, a.ids, counts[0], counts[1]);
	const theirs = diff(o.ids, b.ids, counts[0], counts[2]);
	if (ours.length === 0) return { text: incoming, conflict: false };
	if (theirs.length === 0) return { text: current, conflict: false };

	const merges = combine(ours, theirs, a, b, o.ids.length);
	refine(merges, a, b);
	simplify(merges);
	return fill(merges, o, a, b);
}

// ============================================================================
// The diff: xdl_do_diff, xdl_change_compact, xdl_build_script
// ============================================================================

/** One change of an edit script: `chg1` lines at `i1` of the old file became `chg2` at `i2` of the new. */
type Change = { i1: number; i2: number; chg1: number; chg2: number };

/** A file's changed-line marks, indexable from -1 to `n` as xdiff's `rchg` is. */
function marks(n: number) {
	const array = new Uint8Array(n + 2);
	return {
		get: (i: number) => array[i + 1] ?? 0,
		set: (i: number, value: number) => {
			array[i + 1] = value;
		},
	};
}
type Marks = ReturnType<typeof marks>;

/**
 * The edit script from `ids1` to `ids2`, compacted as Git compacts it.
 * `count1`/`count2` count each class's records in each file.
 */
function diff(
	ids1: number[],
	ids2: number[],
	count1: number[],
	count2: number[],
): Change[] {
	const n1 = ids1.length;
	const n2 = ids2.length;
	const rchg1 = marks(n1);
	const rchg2 = marks(n2);

	// xdl_trim_ends: the common prefix and suffix are never compared.
	const lim = Math.min(n1, n2);
	let start = 0;
	while (start < lim && ids1[start] === ids2[start]) start++;
	let tail = 0;
	while (tail < lim - start && ids1[n1 - 1 - tail] === ids2[n2 - 1 - tail])
		tail++;
	const dend1 = n1 - tail - 1;
	const dend2 = n2 - tail - 1;

	// xdl_cleanup_records: a line with no match on the other side is changed
	// outright; one matching too often is discarded when unmatched lines
	// surround it.
	const discard = (
		ids: number[],
		dend: number,
		otherCount: number[],
		rchg: Marks,
	) => {
		let mlim = bogosqrt(ids.length);
		if (mlim > MAX_EQLIMIT) mlim = MAX_EQLIMIT;
		const dis = new Uint8Array(ids.length + 1);
		for (let i = start; i <= dend; i++) {
			const nm = otherCount[ids[i] as number] ?? 0;
			dis[i] = nm === 0 ? 0 : nm >= mlim ? 2 : 1;
		}
		const rindex: number[] = [];
		const ha: number[] = [];
		for (let i = start; i <= dend; i++) {
			if (dis[i] === 1 || (dis[i] === 2 && !cleanMatch(dis, i, start, dend))) {
				rindex.push(i);
				ha.push(ids[i] as number);
			} else rchg.set(i, 1);
		}
		return { rindex, ha };
	};
	const kept1 = discard(ids1, dend1, count2, rchg1);
	const kept2 = discard(ids2, dend2, count1, rchg2);

	compare(kept1, kept2, rchg1, rchg2);
	compact(ids1, rchg1, ids2, rchg2);
	compact(ids2, rchg2, ids1, rchg1);

	// xdl_build_script: pair the groups of changed lines, from the end.
	const script: Change[] = [];
	for (let i1 = n1, i2 = n2; i1 >= 0 || i2 >= 0; i1--, i2--)
		if (rchg1.get(i1 - 1) || rchg2.get(i2 - 1)) {
			const l1 = i1;
			while (rchg1.get(i1 - 1)) i1--;
			const l2 = i2;
			while (rchg2.get(i2 - 1)) i2--;
			script.unshift({ i1, i2, chg1: l1 - i1, chg2: l2 - i2 });
		}
	return script;
}

/** xdiff's `xdl_bogosqrt`. */
function bogosqrt(n: number) {
	let i = 1;
	for (; n > 0; n >>= 2) i <<= 1;
	return i;
}

/** xdiff's `xdl_clean_mmatch`: whether a many-match line sits among unmatched ones. */
function cleanMatch(dis: Uint8Array, i: number, s: number, e: number) {
	if (i - s > SIMSCAN_WINDOW) s = i - SIMSCAN_WINDOW;
	if (e - i > SIMSCAN_WINDOW) e = i + SIMSCAN_WINDOW;
	let rdis0 = 0;
	let rpdis0 = 1;
	for (let r = 1; i - r >= s; r++) {
		if (!dis[i - r]) rdis0++;
		else if (dis[i - r] === 2) rpdis0++;
		else break;
	}
	if (rdis0 === 0) return false;
	let rdis1 = 0;
	let rpdis1 = 1;
	for (let r = 1; i + r <= e; r++) {
		if (!dis[i + r]) rdis1++;
		else if (dis[i + r] === 2) rpdis1++;
		else break;
	}
	if (rdis1 === 0) return false;
	rdis1 += rdis0;
	rpdis1 += rpdis0;
	return rpdis1 * KPDIS_RUN < rpdis1 + rdis1;
}

type Kept = { rindex: number[]; ha: number[] };

/** xdiff's `xdl_recs_cmp`: mark every kept line the minimal diff changes. */
function compare(k1: Kept, k2: Kept, rchg1: Marks, rchg2: Marks) {
	const ha1 = k1.ha;
	const ha2 = k2.ha;
	const size = ha1.length + ha2.length + 3;
	const base = ha2.length + 1;
	const kvdf = new Int32Array(size);
	const kvdb = new Int32Array(size);
	const stack: [number, number, number, number][] = [
		[0, ha1.length, 0, ha2.length],
	];
	while (stack.length > 0) {
		let [off1, lim1, off2, lim2] = stack.pop() as [
			number,
			number,
			number,
			number,
		];
		while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) {
			off1++;
			off2++;
		}
		while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) {
			lim1--;
			lim2--;
		}
		if (off1 === lim1) {
			for (; off2 < lim2; off2++) rchg2.set(k2.rindex[off2] as number, 1);
		} else if (off2 === lim2) {
			for (; off1 < lim1; off1++) rchg1.set(k1.rindex[off1] as number, 1);
		} else {
			const [s1, s2] = split(
				ha1,
				off1,
				lim1,
				ha2,
				off2,
				lim2,
				kvdf,
				kvdb,
				base,
			);
			// The first half is compared first, as xdiff recurses.
			stack.push([s1, lim1, s2, lim2]);
			stack.push([off1, s1, off2, s2]);
		}
	}
}

/** xdiff's `xdl_split` without its heuristics: where a minimal path crosses the middle. */
function split(
	ha1: number[],
	off1: number,
	lim1: number,
	ha2: number[],
	off2: number,
	lim2: number,
	kvdf: Int32Array,
	kvdb: Int32Array,
	base: number,
): [number, number] {
	const dmin = off1 - lim2;
	const dmax = lim1 - off2;
	const fmid = off1 - off2;
	const bmid = lim1 - lim2;
	const odd = (fmid - bmid) & 1;
	let fmin = fmid;
	let fmax = fmid;
	let bmin = bmid;
	let bmax = bmid;
	const f = (d: number) => kvdf[base + d] as number;
	const b = (d: number) => kvdb[base + d] as number;
	kvdf[base + fmid] = off1;
	kvdb[base + bmid] = lim1;
	for (;;) {
		if (fmin > dmin) kvdf[base + --fmin - 1] = -1;
		else ++fmin;
		if (fmax < dmax) kvdf[base + ++fmax + 1] = -1;
		else --fmax;
		for (let d = fmax; d >= fmin; d -= 2) {
			let i1 = f(d - 1) >= f(d + 1) ? f(d - 1) + 1 : f(d + 1);
			let i2 = i1 - d;
			while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) {
				i1++;
				i2++;
			}
			kvdf[base + d] = i1;
			if (odd && bmin <= d && d <= bmax && b(d) <= i1) return [i1, i2];
		}
		if (bmin > dmin) kvdb[base + --bmin - 1] = LINE_MAX;
		else ++bmin;
		if (bmax < dmax) kvdb[base + ++bmax + 1] = LINE_MAX;
		else --bmax;
		for (let d = bmax; d >= bmin; d -= 2) {
			let i1 = b(d - 1) < b(d + 1) ? b(d - 1) : b(d + 1) - 1;
			let i2 = i1 - d;
			while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) {
				i1--;
				i2--;
			}
			kvdb[base + d] = i1;
			if (!odd && fmin <= d && d <= fmax && i1 <= f(d)) return [i1, i2];
		}
	}
}

/**
 * xdiff's `xdl_change_compact` without the indent heuristic: slide each
 * group of changed lines as far down as it goes, merging groups it meets,
 * then back up to line up with a change in the other file if one is in
 * reach.
 */
function compact(ids: number[], rchg: Marks, idso: number[], rchgo: Marks) {
	const n = ids.length;
	const no = idso.length;
	type Group = { start: number; end: number };
	const init = (r: Marks): Group => {
		let end = 0;
		while (r.get(end)) end++;
		return { start: 0, end };
	};
	const next = (r: Marks, nrec: number, g: Group) => {
		if (g.end === nrec) return false;
		g.start = g.end + 1;
		for (g.end = g.start; r.get(g.end); g.end++);
		return true;
	};
	const previous = (r: Marks, g: Group) => {
		if (g.start === 0) return false;
		g.end = g.start - 1;
		for (g.start = g.end; r.get(g.start - 1); g.start--);
		return true;
	};
	const slideDown = (g: Group) => {
		if (g.end < n && ids[g.start] === ids[g.end]) {
			rchg.set(g.start++, 0);
			rchg.set(g.end++, 1);
			while (rchg.get(g.end)) g.end++;
			return true;
		}
		return false;
	};
	const slideUp = (g: Group) => {
		if (g.start > 0 && ids[g.start - 1] === ids[g.end - 1]) {
			rchg.set(--g.start, 1);
			rchg.set(--g.end, 0);
			while (rchg.get(g.start - 1)) g.start--;
			return true;
		}
		return false;
	};
	const broken = () => {
		throw new Error('line merge: group sync broken');
	};

	const g = init(rchg);
	const go = init(rchgo);
	for (;;) {
		if (g.end !== g.start) {
			let groupSize: number;
			let earliestEnd: number;
			let endMatchingOther: number;
			do {
				groupSize = g.end - g.start;
				endMatchingOther = -1;
				while (slideUp(g)) if (!previous(rchgo, go)) broken();
				earliestEnd = g.end;
				if (go.end > go.start) endMatchingOther = g.end;
				while (slideDown(g)) {
					if (!next(rchgo, no, go)) broken();
					if (go.end > go.start) endMatchingOther = g.end;
				}
			} while (groupSize !== g.end - g.start);
			if (g.end !== earliestEnd && endMatchingOther !== -1)
				while (go.end === go.start) {
					if (!slideUp(g)) broken();
					if (!previous(rchgo, go)) broken();
				}
		}
		if (!next(rchg, n, g)) break;
		if (!next(rchgo, no, go)) broken();
	}
}

// ============================================================================
// The merge: xdl_do_merge, xdl_refine_conflicts, xdl_simplify_non_conflicts
// ============================================================================

/**
 * One region of the result. `mode` 0 is a conflict, 1 takes current, 2
 * takes incoming, 4 is both sides making one change. `i1`/`chg1` index
 * current, `i2`/`chg2` incoming.
 */
type Merge = {
	mode: number;
	i1: number;
	chg1: number;
	i2: number;
	chg2: number;
};

type Side = { lines: string[]; ids: number[] };

function combine(
	ours: Change[],
	theirs: Change[],
	a: Side,
	b: Side,
	baseLength: number,
): Merge[] {
	const merges: Merge[] = [];
	const append = (
		mode: number,
		i1: number,
		chg1: number,
		i2: number,
		chg2: number,
	) => {
		const m = merges.at(-1);
		if (m && (i1 <= m.i1 + m.chg1 || i2 <= m.i2 + m.chg2)) {
			if (mode !== m.mode) m.mode = 0;
			m.chg1 = i1 + chg1 - m.i1;
			m.chg2 = i2 + chg2 - m.i2;
		} else merges.push({ mode, i1, chg1, i2, chg2 });
	};
	const same = (x: Change, y: Change) => {
		if (x.i1 !== y.i1 || x.chg1 !== y.chg1 || x.chg2 !== y.chg2) return false;
		for (let k = 0; k < x.chg2; k++)
			if (a.ids[x.i2 + k] !== b.ids[y.i2 + k]) return false;
		return true;
	};
	let p = 0;
	let q = 0;
	while (p < ours.length && q < theirs.length) {
		const x = ours[p] as Change;
		const y = theirs[q] as Change;
		if (x.i1 + x.chg1 < y.i1) {
			append(1, x.i2, x.chg2, y.i2 - y.i1 + x.i1, x.chg1);
			p++;
			continue;
		}
		if (y.i1 + y.chg1 < x.i1) {
			append(2, x.i2 - x.i1 + y.i1, y.chg1, y.i2, y.chg2);
			q++;
			continue;
		}
		if (!same(x, y)) {
			const off = x.i1 - y.i1;
			const ffo = off + x.chg1 - y.chg1;
			let i1 = x.i2;
			let i2 = y.i2;
			if (off > 0) {
				i1 -= off;
			} else i2 += off;
			let chg1 = x.i2 + x.chg2 - i1;
			let chg2 = y.i2 + y.chg2 - i2;
			if (ffo < 0) chg1 -= ffo;
			else chg2 += ffo;
			append(0, i1, chg1, i2, chg2);
		}
		const end1 = x.i1 + x.chg1;
		const end2 = y.i1 + y.chg1;
		if (end1 >= end2) q++;
		if (end2 >= end1) p++;
	}
	const shift1 = a.ids.length - baseLength;
	const shift2 = b.ids.length - baseLength;
	for (; p < ours.length; p++) {
		const x = ours[p] as Change;
		append(1, x.i2, x.chg2, x.i1 + shift2, x.chg1);
	}
	for (; q < theirs.length; q++) {
		const y = theirs[q] as Change;
		append(2, y.i1 + shift1, y.chg1, y.i2, y.chg2);
	}
	return merges;
}

/** Narrow each conflict to the lines its two sides do not share, as xdiff's ZEALOUS level does. */
function refine(merges: Merge[], a: Side, b: Side) {
	for (let at = 0; at < merges.length; at++) {
		const m = merges[at] as Merge;
		if (m.mode !== 0 || m.chg1 === 0 || m.chg2 === 0) continue;
		const ids1 = a.ids.slice(m.i1, m.i1 + m.chg1);
		const ids2 = b.ids.slice(m.i2, m.i2 + m.chg2);
		const count1: number[] = [];
		const count2: number[] = [];
		for (const id of ids1) count1[id] = (count1[id] ?? 0) + 1;
		for (const id of ids2) count2[id] = (count2[id] ?? 0) + 1;
		const script = diff(ids1, ids2, count1, count2);
		if (script.length === 0) {
			m.mode = 4;
			continue;
		}
		const pieces = script.map(
			(change): Merge => ({
				mode: 0,
				i1: change.i1 + m.i1,
				chg1: change.chg1,
				i2: change.i2 + m.i2,
				chg2: change.chg2,
			}),
		);
		merges.splice(at, 1, ...pieces);
		at += pieces.length - 1;
	}
}

/** Join two conflicts separated by three lines or fewer (`xdl_simplify_non_conflicts`). */
function simplify(merges: Merge[]) {
	let at = 0;
	while (at + 1 < merges.length) {
		const m = merges[at] as Merge;
		const next = merges[at + 1] as Merge;
		const begin = m.i1 + m.chg1;
		const end = next.i1;
		if (m.mode !== 0 || next.mode !== 0 || end - begin > 3) {
			at++;
			continue;
		}
		m.chg1 = next.i1 + next.chg1 - m.i1;
		m.chg2 = next.i2 + next.chg2 - m.i2;
		merges.splice(at + 1, 1);
	}
}

/** xdiff's `is_eol_crlf`: 1, 0, or -1 when the file cannot tell. */
function isEolCrlf(lines: string[], i: number): number {
	const crlf = (line: string | undefined) =>
		line !== undefined && line.length > 1 && line.endsWith('\r\n') ? 1 : 0;
	if (i < lines.length - 1) return crlf(lines[i]);
	if (lines.length === 0) return -1;
	const last = lines[i] as string;
	if (last.endsWith('\n')) return crlf(last);
	if (i === 0) return -1;
	return crlf(lines[i - 1]);
}

/** Write the result: xdiff's `xdl_fill_merge_buffer` and `fill_conflict_hunk`. */
function fill(merges: Merge[], o: Side, a: Side, b: Side): LineMerge {
	let out = '';
	let conflict = false;
	const copy = (
		lines: string[],
		from: number,
		count: number,
		needsCr: boolean,
		addNl: boolean,
	) => {
		if (count < 1) return;
		for (let k = 0; k < count; k++) out += lines[from + k];
		const last = lines[from + count - 1] as string;
		if (addNl && !last.endsWith('\n')) out += needsCr ? '\r\n' : '\n';
	};
	let i = 0;
	for (const m of merges) {
		if (m.mode === 4) continue;
		let needsCr = isEolCrlf(a.lines, m.i1 ? m.i1 - 1 : 0);
		if (needsCr) needsCr = isEolCrlf(b.lines, m.i2 ? m.i2 - 1 : 0);
		if (needsCr) needsCr = isEolCrlf(o.lines, 0);
		const cr = needsCr > 0;
		const eol = cr ? '\r\n' : '\n';
		copy(a.lines, i, m.i1 - i, false, false);
		if (m.mode === 0) {
			conflict = true;
			out += `${'<'.repeat(MARKER_SIZE)} ${CURRENT}${eol}`;
			copy(a.lines, m.i1, m.chg1, cr, true);
			out += `${'='.repeat(MARKER_SIZE)}${eol}`;
			copy(b.lines, m.i2, m.chg2, cr, true);
			out += `${'>'.repeat(MARKER_SIZE)} ${INCOMING}${eol}`;
		} else if (m.mode === 1) copy(a.lines, m.i1, m.chg1, cr, false);
		else copy(b.lines, m.i2, m.chg2, false, false);
		i = m.i1 + m.chg1;
	}
	copy(a.lines, i, a.lines.length - i, false, false);
	return { text: out, conflict };
}
