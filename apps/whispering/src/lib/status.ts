/**
 * The plain-language status line the header shows: where the recordings
 * are kept, which each variant's `Chrome` says (this browser for good on
 * the web, ADR-0700; the data folder on the desktop). Signing in changes
 * nothing here: it adds hosted transcription and AI, never storage. An
 * answer whose result could not be kept outranks it.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

/** The web app's line: this browser keeps the recordings, for good. */
export const ON_THIS_BROWSER: StatusLine = {
	label: 'On this browser',
	detail:
		'Your recordings are kept in this browser’s storage for this site. They never upload; signing in only adds hosted transcription and AI.',
	tone: 'neutral',
};

/** `kept`, unless an answer whose result could not be kept outranks it. */
export function headerStatus(
	state: {
		/** Answers that arrived and whose result note could not be created. */
		readonly unwrittenAnswers: number;
	},
	kept: StatusLine,
): StatusLine {
	const { unwrittenAnswers: unwritten } = state;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not saved yet`,
			short: 'Answer not saved',
			detail:
				'The answer is kept in this window: open its result to save it again or copy it. If the window closes first, it is lost, and you can run it again.',
			tone: 'error',
		};
	return kept;
}
