/**
 * The feed's pure rules: when a recording was made, its order, its day
 * heading, and whether it matches a search. Nothing here reads a file.
 */

export type Sort = 'newest' | 'oldest';

/** `timeId`'s stamp: `2026-10-30T22-41-05-123Z-k3x9a2f8`. */
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

/**
 * When the recording `id` was made, read from the id itself, so audio with
 * no note still has a time. Undefined for an id `timeId` did not make.
 */
export function recordedAt(id: string): Date | undefined {
	const match = STAMP.exec(id);
	if (!match) return undefined;
	const [, day, h, m, s, ms] = match;
	return new Date(`${day}T${h}:${m}:${s}.${ms}Z`);
}

/** Ids sort by time because `timeId` puts the time first. */
export function sortById<T extends { id: string }>(
	items: T[],
	sort: Sort,
): T[] {
	const sorted = items.toSorted((a, b) => a.id.localeCompare(b.id));
	return sort === 'newest' ? sorted.reverse() : sorted;
}

/** Whether `text` holds every word of `query`, ignoring case. */
export function matches(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

/** The local calendar day of `at`, as a key that two moments on one day share. */
const dayKey = (at: Date) =>
	`${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

/** "Today", "Yesterday", or the date, with the year only when it is not this year's. */
export function dayLabel(at: Date, now = new Date()): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (dayKey(at) === dayKey(now)) return 'Today';
	if (dayKey(at) === dayKey(yesterday)) return 'Yesterday';
	return at.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
	});
}

/** `items` in runs of one local day each, in the order given. */
export function groupByDay<T>(
	items: T[],
	dateOf: (item: T) => Date | undefined,
	now = new Date(),
): { label: string; items: T[] }[] {
	const groups: { key: string; label: string; items: T[] }[] = [];
	for (const item of items) {
		const at = dateOf(item);
		const key = at ? dayKey(at) : 'unknown';
		const last = groups.at(-1);
		if (last?.key === key) last.items.push(item);
		else
			groups.push({
				key,
				label: at ? dayLabel(at, now) : 'Unknown date',
				items: [item],
			});
	}
	return groups.map(({ label, items }) => ({ label, items }));
}

/** `0:42`, `12:05`, or `1:02:05`. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
