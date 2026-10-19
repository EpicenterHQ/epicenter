/** Line-region merge with current-first simultaneous insertion union (ADR-0622). */
/** A text as its lines, none holding a line feed, and whether a line feed ends it. */
type Lines = { lines: string[]; eol: boolean };

function split(text: string): Lines {
	if (text === '') return { lines: [], eol: false };
	const lines = text.split('\n');
	const eol = lines.at(-1) === '';
	if (eol) lines.pop();
	return { lines, eol };
}

function join(lines: string[], eol: boolean): string {
	if (lines.length === 0) return '';
	return lines.join('\n') + (eol ? '\n' : '');
}

/** A run of one version's lines, and whether a line feed ends its last line there. */
type Segment = { lines: string[]; eol: boolean };

/** Lines as region text: each with its line feed. */
const block = (lines: string[]) => lines.map((line) => `${line}\n`).join('');

/** One run of changed lines of a side, as half-open ranges of the base and the side. */
type Hunk = {
	side: 'change' | 'current';
	baseStart: number;
	baseEnd: number;
	sideStart: number;
	sideEnd: number;
};

/** A base and two sides' texts, merged by line. */
type TextVersions = {
	base: string;
	change: string;
	current: string;
};

/** A competing region's 0-based line and retained line count in the result. */
export type CompetingRegion = {
	line: number;
	count: number;
};

/** Merged text and the competing regions where the change replaced current content. */
export type LineMerge = {
	content: string;
	regions: readonly CompetingRegion[];
};

/**
 * The line merge of three texts. With `union: false`, two different
 * insertions at one place compete like any other region, for text where two
 * lines added side by side would mean something else, such as two values
 * of one frontmatter key.
 */
export async function mergeLines(
	{ base, change, current }: TextVersions,
	{ union = true }: { union?: boolean } = {},
): Promise<LineMerge> {
	// Load the diff implementation only when both sides changed text.
	const { diffArrays } = await import('diff');
	const [b, o, t] = [split(base), split(change), split(current)] as const;

	function hunks(side: Hunk['side'], changed: string[]): Hunk[] {
		const found: Hunk[] = [];
		let open: Hunk | undefined;
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

	const all = [...hunks('change', o.lines), ...hunks('current', t.lines)].sort(
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
		const [changeEol, currentEol] = [o, t].map((side) =>
			side.lines.length === 0 ? b.eol : side.eol,
		) as [boolean, boolean];
		return changeEol === currentEol || currentEol === b.eol
			? changeEol
			: currentEol;
	};
	const result: string[] = [];
	// Whether a line feed ends each result: as it ends the side its last line came from.
	let ending = false;
	const regions: CompetingRegion[] = [];
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
			result.push(...unchanged);
			ending = baseEnding(start);
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
			const version = side === 'change' ? o : t;
			const stop = last.sideEnd + (end - last.baseEnd);
			return {
				lines: version.lines.slice(
					first.sideStart - (first.baseStart - start),
					stop,
				),
				eol: stop === version.lines.length ? version.eol : true,
			};
		};
		const [left, right] = [across('change'), across('current')];
		const [leftText, rightText] = [block(left.lines), block(right.lines)];
		let settled: Segment[] | undefined;
		if (leftText === rightText)
			settled = [{ ...left, eol: left.eol === right.eol ? left.eol : true }];
		else if (group.every((hunk) => hunk.side === 'change')) settled = [left];
		else if (group.every((hunk) => hunk.side === 'current')) settled = [right];
		// Both inserted different lines here, replacing nothing: keep both,
		// current first as what landed first, or the longer where one extends
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
				result.push(...segment.lines);
				ending = segment.eol;
			}
			continue;
		}
		regions.push({ line: result.length, count: left.lines.length });
		if (left.lines.length > 0) {
			result.push(...left.lines);
			ending = left.eol;
		}
	}
	const rest = b.lines.slice(cursor);
	if (rest.length > 0) {
		result.push(...rest);
		ending = baseEnding(b.lines.length);
	}
	return {
		content: join(result, ending),
		regions,
	};
}

/** Whether `longer` holds every line of `shorter` at its start or its end. */
function extendsLines(longer: string[], shorter: string[]) {
	if (longer.length <= shorter.length) return false;
	const at = (offset: number) =>
		shorter.every((line, index) => line === longer[offset + index]);
	return at(0) || at(longer.length - shorter.length);
}
