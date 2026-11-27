/** A browser tab has no floating window; Home and the recording strip show the take instead. */
import type { Pill } from './pill';

export const browserPill: Pill = {
	publish() {},
	onAction: () => () => {},
	onState: () => () => {},
	send() {},
	setShown() {},
};
