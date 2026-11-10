/**
 * Captures grouped by the day they were captured, in this device's time
 * zone, each day labeled the way a person says it: Today, Yesterday, a
 * weekday within the week, then a date.
 */

/** The parsed moment of `capturedAt`, or undefined when it names none. */
export function instantOf(capturedAt: string | undefined): Date | undefined {
	if (capturedAt === undefined) return undefined;
	const at = new Date(capturedAt);
	return Number.isNaN(at.getTime()) ? undefined : at;
}

/** Midnight of `at`'s day, here. */
function dayOf(at: Date): Date {
	return new Date(at.getFullYear(), at.getMonth(), at.getDate());
}

/** What to call the day of `at`, seen on `now`. */
export function dayLabel(at: Date, now = new Date(), locale?: string): string {
	const days = Math.round(
		(dayOf(now).getTime() - dayOf(at).getTime()) / 86_400_000,
	);
	if (days === 0) return 'Today';
	if (days === 1) return 'Yesterday';
	if (days > 1 && days < 7)
		return at.toLocaleDateString(locale, { weekday: 'long' });
	return at.toLocaleDateString(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
	});
}

/**
 * `rows`, in the order given, as consecutive days: a new group starts when
 * the day changes. Rows with no date gather in one group, `No date`, last.
 */
export function byDay<TRow extends { capturedAt?: string }>(
	rows: readonly TRow[],
	now = new Date(),
	locale?: string,
): { key: string; label: string; rows: TRow[] }[] {
	const groups: { key: string; label: string; rows: TRow[] }[] = [];
	const undated: TRow[] = [];
	for (const row of rows) {
		const at = instantOf(row.capturedAt);
		if (at === undefined) {
			undated.push(row);
			continue;
		}
		const key = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
		const last = groups.at(-1);
		if (last?.key === key) last.rows.push(row);
		else groups.push({ key, label: dayLabel(at, now, locale), rows: [row] });
	}
	if (undated.length)
		groups.push({ key: 'undated', label: 'No date', rows: undated });
	return groups;
}
