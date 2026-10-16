/**
 * The line merge save and Sync use for a row body and a text file both sides
 * changed (ADR-0551).
 *
 * Each side's changes against the base are diffed by line; changes that
 * overlap on the base, or insert at the same place, are one region. Changes
 * to neighboring lines do not overlap, so both are kept: lines compete only
 * where both sides changed the same lines. A region only one side changed
 * takes that side's lines, a region both sides changed identically takes
 * those lines, and any other region competes.
 *
 * One pass answers both sides of the merge: `ours` is the merged text with
 * ours winning every competing region, `theirs` the merged text with theirs
 * winning them. Either keeps every line the other side changed outside a
 * competing region. The two are equal exactly when nothing competed.
 */

/**
 * Lines ending at each line feed, the last without one. Every character
 * lands in a line, a lone carriage return, U+2028, and U+2029 included.
 */
const LINES = /[^\n]*\n|[^\n]+$/g;

const lines = (text: string) => text.match(LINES) ?? [];

/** One run of changed lines of a side, as half-open ranges of the base and the side. */
type Hunk = {
	readonly side: 'ours' | 'theirs';
	readonly baseStart: number;
	readonly baseEnd: number;
	readonly sideStart: number;
	readonly sideEnd: number;
};

/** A base and two sides' texts, merged by line. */
type LineVersions = {
	readonly base: string;
	readonly ours: string;
	readonly theirs: string;
};

/**
 * One region both sides changed differently: `kept` is our lines, which
 * stand in the ours-winning text from the 0-based `line`, and `theirs` the
 * lines theirs had there. Lines end with their line feeds.
 */
export type SettledRegion = {
	readonly line: number;
	readonly kept: string;
	readonly theirs: string;
};

/** Both sides of one line merge, and each region that competed. */
export type LineMerge = {
	/** The merge with ours winning every competing region. */
	readonly ours: string;
	/** The merge with theirs winning every competing region. */
	readonly theirs: string;
	/** Each competing region, in order. Empty when nothing competed. */
	readonly regions: readonly SettledRegion[];
};

/**
 * The line merge of three texts. Every input byte of a kept line lands in
 * the output, so a text with no line break at its end keeps that.
 */
export async function mergeLines({
	base,
	ours,
	theirs,
}: LineVersions): Promise<LineMerge> {
	// Loaded when a merge needs it: the shell's diff uses the same library,
	// and a static import would put it in this module's chunk.
	const { diffArrays } = await import('diff');
	const [b, o, t] = [lines(base), lines(ours), lines(theirs)] as const;

	function hunks(side: Hunk['side'], changed: readonly string[]): Hunk[] {
		const found: Hunk[] = [];
		let open: { -readonly [K in keyof Hunk]: Hunk[K] } | undefined;
		let atBase = 0;
		let atSide = 0;
		for (const change of diffArrays([...b], [...changed])) {
			if (!change.added && !change.removed) {
				if (open !== undefined) found.push(open);
				open = undefined;
				atBase += change.count;
				atSide += change.count;
				continue;
			}
			open ??= {
				side,
				baseStart: atBase,
				baseEnd: atBase,
				sideStart: atSide,
				sideEnd: atSide,
			};
			if (change.removed) open.baseEnd = atBase += change.count;
			else open.sideEnd = atSide += change.count;
		}
		if (open !== undefined) found.push(open);
		return found;
	}

	const all = [...hunks('ours', o), ...hunks('theirs', t)].sort(
		(left, right) =>
			left.baseStart - right.baseStart || left.baseEnd - right.baseEnd,
	);
	let mine = '';
	let yours = '';
	const regions: SettledRegion[] = [];
	let cursor = 0;
	for (let index = 0; index < all.length; ) {
		const start = all[index]!.baseStart;
		let end = all[index]!.baseEnd;
		const group = [all[index++]!];
		// A change joins the region when it overlaps it on the base, or when
		// both insert at the same place. Neighboring changes stay apart.
		const joins = (next: Hunk) =>
			next.baseStart < end ||
			(next.baseStart === end && next.baseEnd === end && start === end);
		while (index < all.length && joins(all[index]!)) {
			end = Math.max(end, all[index]!.baseEnd);
			group.push(all[index++]!);
		}
		const unchanged = b.slice(cursor, start).join('');
		mine += unchanged;
		yours += unchanged;
		cursor = end;
		/** The side's lines standing where the base has `start` to `end`. */
		const across = (side: Hunk['side']) => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) return b.slice(start, end).join('');
			const first = own[0]!;
			const last = own[own.length - 1]!;
			return (side === 'ours' ? o : t)
				.slice(
					first.sideStart - (first.baseStart - start),
					last.sideEnd + (end - last.baseEnd),
				)
				.join('');
		};
		const [left, right] = [across('ours'), across('theirs')];
		let settled: string | undefined;
		if (left === right || group.every((hunk) => hunk.side === 'ours'))
			settled = left;
		else if (group.every((hunk) => hunk.side === 'theirs')) settled = right;
		if (settled !== undefined) {
			mine += settled;
			yours += settled;
			continue;
		}
		regions.push({ line: lines(mine).length, kept: left, theirs: right });
		mine += left;
		yours += right;
	}
	const rest = b.slice(cursor).join('');
	return { ours: mine + rest, theirs: yours + rest, regions };
}

/**
 * `ours` and `theirs` as one text with Git's conflict markers around each
 * run of lines where they differ, as `git merge-file` writes a conflict in
 * its default style. Lines both share stand once, unmarked. A side whose
 * differing lines end without a line feed gets one before the next marker.
 */
export async function markConflicts(
	{ ours, theirs }: { readonly ours: string; readonly theirs: string },
	labels: { readonly ours: string; readonly theirs: string },
): Promise<string> {
	const { diffArrays } = await import('diff');
	const closed = (text: string) =>
		text === '' || text.endsWith('\n') ? text : `${text}\n`;
	let marked = '';
	let mine = '';
	let yours = '';
	const flush = () => {
		if (mine === '' && yours === '') return;
		marked += `<<<<<<< ${labels.ours}\n${closed(mine)}=======\n${closed(yours)}>>>>>>> ${labels.theirs}\n`;
		mine = '';
		yours = '';
	};
	for (const change of diffArrays(lines(ours), lines(theirs))) {
		const text = change.value.join('');
		if (change.removed) mine += text;
		else if (change.added) yours += text;
		else {
			flush();
			marked += text;
		}
	}
	flush();
	return marked;
}
