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
 * Two different insertions at the same place both survive, theirs first:
 * the file as it was already written, then what the writer acting adds.
 * Where one block holds the other at its start or end, the longer stands
 * alone, so an insertion sent again after it landed, or extended since, is
 * not doubled. Any other region both changed differently competes.
 *
 * Lines compare without their line feeds, so appending to a text with no
 * line feed at its end is an insertion after its last line, not a change of
 * it. A result ends with a line feed as the version its last line came from
 * ends there. A lone carriage return, U+2028, and U+2029 stay inside their
 * line.
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

/** A run of one version's lines, and whether a line feed ends its last line there. */
type Segment = { readonly lines: readonly string[]; readonly eol: boolean };

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

/**
 * The line merge of three texts. With `union: false`, two different
 * insertions at one place compete like any other region, for text where two
 * lines added side by side would mean something else, such as two values
 * of one frontmatter key.
 */
export async function mergeLines(
	{ base, ours, theirs }: LineVersions,
	{ union = true }: { readonly union?: boolean } = {},
): Promise<LineMerge> {
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
	/**
	 * Whether a line feed ends base line `end - 1` in the merge. Before the
	 * last line it always does; the last line both sides kept ends as the
	 * sides decide, where one changing it wins, and a side with no text
	 * says nothing about it.
	 */
	const baseEnding = (end: number) => {
		if (end < b.lines.length) return true;
		const [ourEol, theirEol] = [o, t].map((side) =>
			side.lines.length === 0 ? b.eol : side.eol,
		) as [boolean, boolean];
		return ourEol === theirEol || theirEol === b.eol ? ourEol : theirEol;
	};
	const mine: string[] = [];
	const yours: string[] = [];
	// Whether a line feed ends each result: as it ends the side its last line came from.
	let mineEol = false;
	let yoursEol = false;
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
		if (unchanged.length > 0) {
			mine.push(...unchanged);
			yours.push(...unchanged);
			mineEol = yoursEol = baseEnding(start);
		}
		cursor = end;
		/**
		 * The side's lines standing where the base has `start` to `end`, and
		 * whether a line feed ends the last of them in that side.
		 */
		const across = (side: Hunk['side']): Segment => {
			const own = group.filter((hunk) => hunk.side === side);
			if (own.length === 0)
				return { lines: b.lines.slice(start, end), eol: baseEnding(end) };
			const first = own[0]!;
			const last = own[own.length - 1]!;
			const version = side === 'ours' ? o : t;
			const stop = last.sideEnd + (end - last.baseEnd);
			return {
				lines: version.lines.slice(
					first.sideStart - (first.baseStart - start),
					stop,
				),
				eol: stop === version.lines.length ? version.eol : true,
			};
		};
		const [left, right] = [across('ours'), across('theirs')];
		const [leftText, rightText] = [block(left.lines), block(right.lines)];
		let settled: readonly Segment[] | undefined;
		if (leftText === rightText)
			settled = [{ ...left, eol: left.eol === right.eol ? left.eol : true }];
		else if (group.every((hunk) => hunk.side === 'ours')) settled = [left];
		else if (group.every((hunk) => hunk.side === 'theirs')) settled = [right];
		// Both inserted different lines here, replacing nothing: keep both,
		// theirs first as what landed first, or the longer where one extends
		// the other, so a resent insertion is not doubled.
		else if (start === end && union)
			settled = extendsLines(right.lines, left.lines)
				? [right]
				: extendsLines(left.lines, right.lines)
					? [left]
					: [right, left];
		if (settled !== undefined) {
			for (const segment of settled) {
				if (segment.lines.length === 0) continue;
				mine.push(...segment.lines);
				yours.push(...segment.lines);
				mineEol = yoursEol = segment.eol;
			}
			continue;
		}
		regions.push({ line: mine.length, kept: leftText, theirs: rightText });
		if (left.lines.length > 0) {
			mine.push(...left.lines);
			mineEol = left.eol;
		}
		if (right.lines.length > 0) {
			yours.push(...right.lines);
			yoursEol = right.eol;
		}
	}
	const rest = b.lines.slice(cursor);
	if (rest.length > 0) {
		mine.push(...rest);
		yours.push(...rest);
		mineEol = yoursEol = baseEnding(b.lines.length);
	}
	return {
		ours: join(mine, mineEol),
		theirs: join(yours, yoursEol),
		regions,
	};
}

/** Whether `longer` holds every line of `shorter` at its start or its end. */
function extendsLines(longer: readonly string[], shorter: readonly string[]) {
	if (longer.length <= shorter.length) return false;
	const at = (offset: number) =>
		shorter.every((line, index) => line === longer[offset + index]);
	return at(0) || at(longer.length - shorter.length);
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
