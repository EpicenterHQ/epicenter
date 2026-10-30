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
 * sending, waiting (the system clears it) and refused (only a person can
 * fix it), by a note's `state` in `@epicenter/repository`. A refused file
 * wins: it is never sent until the person fixes it, so the header must not
 * say Synced; a waiting file is on its way, like a sending one.
 */
export function syncLine({
	sending,
	refused,
}: {
	sending: number;
	refused: number;
}): StatusLine {
	if (refused > 0) {
		const fix = `${files(refused)} ${refused === 1 ? 'is' : 'are'} saved on this device and ${refused === 1 ? 'needs' : 'need'} a fix`;
		return {
			label: 'Not sent',
			detail:
				sending > 0
					? `${fix}; ${files(sending)} ${sending === 1 ? "isn't" : "aren't"} sent yet`
					: fix,
			tone: 'warning',
		};
	}
	if (sending > 0)
		return {
			label: 'Sending…',
			detail: `${files(sending)} not sent yet`,
			tone: 'busy',
		};
	return { label: 'Synced', tone: 'good' };
}

/**
 * RULE: a browser that holds work existing nowhere else (a repository kept
 * only here, or changes not yet sent) and whose storage is not persistent
 * (the request was refused, or never answered) says the browser may delete
 * it; null otherwise. `persistence` is `storagePersistence` from
 * `@epicenter/repository/browser`.
 */
export function storageLine({
	persistence,
	local,
	unsent,
}: {
	persistence: 'checking' | 'not-asked' | 'granted' | 'denied';
	local: boolean;
	unsent: boolean;
}): StatusLine | null {
	if (persistence === 'granted' || persistence === 'checking') return null;
	if (local)
		return {
			label:
				'This repository exists only in this browser, and the browser may delete it when space runs low. Sign in to sync.',
			tone: 'warning',
		};
	if (unsent)
		return {
			label:
				'Unsent changes exist only in this browser, and the browser may delete them when space runs low.',
			tone: 'warning',
		};
	return null;
}
