/**
 * The feed's pure rules: when a recording was made and which are old, its
 * day heading, whether it matches a search and the words around the match,
 * a length as a clock, and how much was dictated. Nothing here reads a file.
 */

import { localDay } from '@epicenter/app/time';

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

/**
 * The ids among `ids` whose recording was made more than `keepDays` days
 * before `now`. An id with no time in it is never one: nothing says it is old.
 */
export function olderThan(
	ids: readonly string[],
	keepDays: number,
	now: Date,
): string[] {
	const cutoff = now.getTime() - keepDays * 86_400_000;
	return ids.filter((id) => {
		const at = recordedAt(id);
		return at !== undefined && at.getTime() < cutoff;
	});
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

/** "Today", "Yesterday", or the date, with the year only when it is not this year's. */
export function dayLabel(at: Date, now = new Date()): string {
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (localDay(at) === localDay(now)) return 'Today';
	if (localDay(at) === localDay(yesterday)) return 'Yesterday';
	return at.toLocaleDateString(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
	});
}

/** `items` in runs of one local day each, in the order given. */
export function groupByDay<T extends { at: Date | undefined }>(
	items: T[],
	now = new Date(),
): { label: string; items: T[] }[] {
	const groups: { label: string; items: T[] }[] = [];
	for (const item of items) {
		const label = item.at ? dayLabel(item.at, now) : 'Unknown date';
		const last = groups.at(-1);
		if (last?.label === label) last.items.push(item);
		else groups.push({ label, items: [item] });
	}
	return groups;
}

/**
 * How much has been dictated: the days with a take, the words in every
 * transcript, and the pace. The pace counts only takes that have both text
 * and a length, and is undefined until one does.
 */
export function usage(
	recordings: {
		at: Date | undefined;
		durationMs: number | undefined;
		transcript: string;
	}[],
): { days: number; words: number; wordsPerMinute: number | undefined } {
	const days = new Set<string>();
	let words = 0;
	let timedWords = 0;
	let timedMs = 0;
	for (const { at, durationMs, transcript } of recordings) {
		if (at) days.add(localDay(at));
		const count = transcript.split(/\s+/).filter(Boolean).length;
		words += count;
		if (count && durationMs) {
			timedWords += count;
			timedMs += durationMs;
		}
	}
	return {
		days: days.size,
		words,
		wordsPerMinute: timedMs
			? Math.round(timedWords / (timedMs / 60_000))
			: undefined,
	};
}

/** `0:42`, `12:05`, or `1:02:05`. */
export function formatDuration(ms: number): string {
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, '0');
	return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A run of text, and whether it is a word the search asked for. */
export type Part = { text: string; hit: boolean };

/**
 * The words of `text` around the first word of `query` it holds, about
 * `width` characters, with each searched word marked, so a list row shows
 * why it matched. With no query, or no match, the start of the text.
 */
export function excerpt(text: string, query: string, width = 80): Part[] {
	const flat = text.replace(/\s+/g, ' ').trim();
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const lower = flat.toLowerCase();
	const first = Math.min(
		...words.map((word) => lower.indexOf(word)).filter((at) => at >= 0),
	);
	let start = Number.isFinite(first)
		? Math.max(0, first - Math.floor(width / 3))
		: 0;
	// Start on a word, not inside one.
	if (start > 0) start = flat.indexOf(' ', start) + 1 || start;
	let end = Math.min(flat.length, start + width);
	// End on a word too, unless that leaves nothing.
	if (end < flat.length)
		end = flat.lastIndexOf(' ', end) > start ? flat.lastIndexOf(' ', end) : end;
	const shown = `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
	if (!words.length) return [{ text: shown, hit: false }];
	const escaped = words.map((word) =>
		word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
	);
	return shown
		.split(new RegExp(`(${escaped.join('|')})`, 'i'))
		.filter(Boolean)
		.map((piece) => ({
			text: piece,
			hit: words.includes(piece.toLowerCase()),
		}));
}
