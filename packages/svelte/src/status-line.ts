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

/** Folder writes may be idle while a draft is still debouncing. */
export function saveLine(saving: boolean): StatusLine {
	return saving
		? { label: 'Saving…', tone: 'busy' }
		: { label: 'On this device', tone: 'neutral' };
}
