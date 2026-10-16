/**
 * The shape and shared rules of a folder app's status lines: one fact each,
 * worded by the app, with a tone the header's dot and the outcome toasts
 * show. A plain module, so a page's status helpers import it without loading
 * Svelte runes. The wording stays with each app; `StatusPopover` from
 * `@epicenter/svelte/status-popover` shows the lines.
 */
import type { PathChange } from '@epicenter/folder';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';

/** One fact as a person reads it. */
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow screens, when `label` is long. */
	readonly short?: string;
	readonly detail?: string;
	readonly tone: Tone;
};

const SEVERITY: Record<Tone, number> = {
	error: 4,
	busy: 3,
	warning: 2,
	neutral: 1,
	good: 0,
};

/**
 * The most severe line, the earlier one on a tie; `undefined` entries are
 * skipped. Each app decides which lines may lead and what a calm header says.
 */
export function mostSevere(
	lines: readonly (StatusLine | undefined)[],
): StatusLine | undefined {
	let chosen: StatusLine | undefined;
	for (const line of lines)
		if (
			line !== undefined &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	return chosen;
}

/** A commit id as a person reads it: its first seven characters. */
export const shortOid = (oid: string | undefined) => oid?.slice(0, 7) ?? 'none';

/**
 * An absolute time, so a line never goes stale on screen: the time alone
 * today, the date and time otherwise.
 */
export function localTime(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

/** The line with when it was observed or attempted as its last detail line. */
export function withTime(
	line: StatusLine,
	event: 'Checked' | 'Last attempt',
	time: number,
): StatusLine {
	const when = `${event} at ${localTime(time)}`;
	return { ...line, detail: line.detail ? `${line.detail}\n${when}` : when };
}

/** The first eight changed paths, one per detail line: `new`, `modified`, or `deleted`, then the path. */
export function changeList(changes: readonly PathChange[]): string[] {
	return changes
		.slice(0, 8)
		.map(
			(change) =>
				`${change.kind === 'add' ? 'new' : change.kind === 'delete' ? 'deleted' : 'modified'} ${change.path}`,
		);
}
