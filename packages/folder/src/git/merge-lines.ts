/**
 * The line merge every write and Sync use for a row body and a text file
 * both sides changed (ADR-0551, ADR-0576).
 *
 * Each side's changes against the base are diffed by line; changes that
 * overlap on the base, or insert at the same place, are one region. Changes
 * to neighboring lines do not overlap, so both are kept. A region only one
 * side changed takes that side's lines, and a region both sides changed
 * identically takes those lines once.
 *
 * Two different insertions at the same place both survive: the two blocks
 * stand one after the other, the one that sorts first by UTF-16 code units
 * first. The order depends on neither side, so two writers who merge the
 * same pair of insertions, each as `ours`, write the same text. Any other
 * region both changed differently competes.
 *
 * Lines compare without their line feeds, and whether the text ends with one
 * merges on its own, so appending to a text with no line feed at its end is
 * an insertion after its last line, not a change of it. A lone carriage
 * return, U+2028, and U+2029 stay inside their line.
 *
 * One pass answers both sides of the merge: `ours` is the merged text with
 * ours winning every competing region, `theirs` the merged text with theirs
 * winning them. Either keeps every line the other side changed outside a
 * competing region. The two are equal exactly when nothing competed.
 */

/** A text as its lines, none holding a line feed, and whether a line feed ends it. */
type Lines = { readonly lines: readonly string[]; readonly eol: boolean };

function split(text: string): Lines {
	if (text === '') return { lines: [], eol: false };
	const lines = text.split('\n');
	const eol = lines.at(-1) === '';
	if (eol) lines.pop();
	return { lines, eol };
}

function join(lines: readonly string[], eol: boolean): string {
	if (lines.length === 0) return '';
	return lines.join('\n') + (eol ? '\n' : '');
}

/** Lines as region text: each with its line feed. */
const block = (lines: readonly string[]) =>
	lines.map((line) => `${line}\n`).join('');

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
 * lines theirs had there. Each line ends with a line feed.
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

/** The line merge of three texts. */
export async function mergeLines({
	base,
	ours,
	theirs,
}: LineVersions): Promise<LineMerge> {
	// Loaded when a merge needs it: the shell's diff uses the same library,
	// and a static import would put it in this module's chunk.
	const { diffArrays } = await import('diff');
	const [b, o, t] = [split(base), split(ours), split(theirs)] as const;

	function hunks(side: Hunk['side'], changed: readonly string[]): Hunk[] {
		const found: Hunk[] = [];
		let open: { -readonly [K in keyof Hunk]: Hunk[K] } | undefined;
		let atBase = 0;
		let atSide = 0;
		for (const change of diffArrays([...b.lines], [...changed])) {
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

	const all = [...hunks('ours', o.lines), ...hunks('theirs', t.lines)].sort(
		(left, right) =>
			left.baseStart - right.baseStart || left.baseEnd - right.baseEnd,
	);
	const mine: string[] = [];
	const yours: string[] = [];
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
		const unchanged = b.lines.slice(cursor, start);
		mine.push(...unchanged);
		yours.push(...unchanged);
		cursor = end;
		/** The side's lines standing where the base has `start` to `end`. */
		const across = (side: Hunk['side']) => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0) return b.lines.slice(start, end);
			const first = own[0]!;
			const last = own[own.length - 1]!;
			return (side === 'ours' ? o : t).lines.slice(
				first.sideStart - (first.baseStart - start),
				last.sideEnd + (end - last.baseEnd),
			);
		};
		const [left, right] = [across('ours'), across('theirs')];
		const [leftText, rightText] = [block(left), block(right)];
		let settled: readonly string[] | undefined;
		if (leftText === rightText || group.every((hunk) => hunk.side === 'ours'))
			settled = left;
		else if (group.every((hunk) => hunk.side === 'theirs')) settled = right;
		// Both inserted different lines here, replacing nothing: keep both.
		else if (start === end)
			settled =
				leftText < rightText ? [...left, ...right] : [...right, ...left];
		if (settled !== undefined) {
			mine.push(...settled);
			yours.push(...settled);
			continue;
		}
		regions.push({ line: mine.length, kept: leftText, theirs: rightText });
		mine.push(...left);
		yours.push(...right);
	}
	const rest = b.lines.slice(cursor);
	mine.push(...rest);
	yours.push(...rest);
	// A final line feed never competes: where the sides differ, one kept the base's.
	const eol = o.eol === t.eol || t.eol === b.eol ? o.eol : t.eol;
	return { ours: join(mine, eol), theirs: join(yours, eol), regions };
}

/**
 * Lines ending at each line feed, the last without one. Every character
 * lands in a line, a lone carriage return, U+2028, and U+2029 included.
 */
const LINES = /[^\n]*\n|[^\n]+$/g;

const lines = (text: string) => text.match(LINES) ?? [];

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
