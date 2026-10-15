/**
 * The line merge sync uses for a row body and a text file both sides changed.
 *
 * Each side's changes against the base are diffed by line; changes that
 * overlap on the base, or insert at the same place, are one region. Changes
 * to neighboring lines do not overlap, so both are kept: lines compete only
 * where both sides changed the same lines. A region only one side changed
 * takes that side's lines, a region both sides changed identically takes
 * those lines, and any other region competes. `mergeLines` makes the
 * whole merge `undefined` when one competes, so the caller holds the unit
 * for a person. `mergeLinesPreferring` settles each competing region with
 * one side's lines and keeps every other region, for a save that decided
 * ahead of time which side wins where both changed the same lines.
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
export type LineVersions = {
	readonly base: string;
	readonly ours: string;
	readonly theirs: string;
};

/**
 * The line merge of three texts, or `undefined` when both sides changed the
 * same lines differently. Every input byte of a kept line lands in the
 * output, so a body with no line break at its end keeps that.
 */
export async function mergeLines(
	versions: LineVersions,
): Promise<string | undefined> {
	return mergeBy(versions, () => undefined);
}

/**
 * One competing region a preferred merge settled: `kept` is the preferred
 * side's lines, which stand in the merged text from the 0-based `line`, and
 * `lost` the other side's lines they replaced.
 */
export type SettledRegion = {
	readonly line: number;
	readonly kept: string;
	readonly lost: string;
};

/** A line merge whose competing regions took one side's lines. */
export type PreferredMerge = {
	readonly text: string;
	/** Each competing region, in order. Empty when no region competed. */
	readonly replaced: readonly SettledRegion[];
};

/**
 * The line merge of three texts where `prefer`'s lines win each region both
 * sides changed differently. Every region only one side changed keeps that
 * side's lines, so nothing outside a competing region is lost from either.
 */
export async function mergeLinesPreferring(
	versions: LineVersions,
	prefer: 'ours' | 'theirs',
): Promise<PreferredMerge> {
	const replaced: SettledRegion[] = [];
	const text = await mergeBy(versions, (mine, yours, line) => {
		const [kept, lost] = prefer === 'ours' ? [mine, yours] : [yours, mine];
		replaced.push({ line, kept, lost });
		return kept;
	});
	// A competing region always resolves, so the merge always has text.
	return { text: text as string, replaced };
}

/**
 * The line merge, where `compete` answers the lines of each region both
 * sides changed differently, given ours and theirs there and the 0-based
 * line of the merged text the region starts at; `undefined` from it makes
 * the whole merge `undefined`.
 */
async function mergeBy(
	{ base, ours, theirs }: LineVersions,
	compete: (mine: string, yours: string, line: number) => string | undefined,
): Promise<string | undefined> {
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
	let merged = '';
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
		merged += b.slice(cursor, start).join('');
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
		const [mine, yours] = [across('ours'), across('theirs')];
		if (mine === yours || group.every((hunk) => hunk.side === 'ours'))
			merged += mine;
		else if (group.every((hunk) => hunk.side === 'theirs')) merged += yours;
		else {
			const settled = compete(mine, yours, lines(merged).length);
			if (settled === undefined) return undefined;
			merged += settled;
		}
	}
	return merged + b.slice(cursor).join('');
}
