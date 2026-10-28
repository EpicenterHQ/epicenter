/**
 * The shape and shared rules of a folder app's status lines: one fact each,
 * worded by the app, with a tone the header's dot shows. A plain module, so
 * a page's status helpers import it without loading Svelte runes.
 * `StatusPopover` from `@epicenter/svelte/status-popover` shows the lines.
 */

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';

/** One fact as a person reads it. */
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow screens, when `label` is long. */
	readonly short?: string;
	readonly detail?: string;
	readonly tone: Tone;
};

/** A neutral label after the Folder's queued writes settle. */
export function saveLine(saving: boolean): StatusLine {
	return saving
		? { label: 'Saving…', tone: 'busy' }
		: { label: 'On this device', tone: 'neutral' };
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/**
 * Where a repository's files stand with its server, from how many are
 * sending and how many are held (see `Sync` in `@epicenter/repository`).
 * A held file wins: it is never sent until the person repairs it, so the
 * header must not say Synced.
 */
export function syncLine({ sending, held }: { sending: number; held: number }): StatusLine {
	if (held > 0) {
		const waits = `${files(held)} ${held === 1 ? 'is' : 'are'} saved on this device and ${held === 1 ? 'waits for its' : 'wait for their'} frontmatter to parse`;
		return { label: 'Not sent', detail: sending > 0 ? `${waits}; ${files(sending)} ${sending === 1 ? "isn't" : "aren't"} sent yet` : waits, tone: 'warning' };
	}
	if (sending > 0) return { label: 'Sending…', detail: `${files(sending)} not sent yet`, tone: 'busy' };
	return { label: 'Synced', tone: 'good' };
}
