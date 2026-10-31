/**
 * The plain-language status line the header shows: where the recordings
 * are kept, which is this browser, for good (ADR-0700). Signing in changes
 * nothing here: it adds hosted transcription and AI, never storage. An
 * answer whose result could not be kept outranks it.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

export function headerStatus(state: {
	/** Answers that arrived and whose result note could not be created. */
	readonly unwrittenAnswers: number;
}): StatusLine {
	const { unwrittenAnswers: unwritten } = state;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not saved yet`,
			short: 'Answer not saved',
			detail:
				'The answer is kept in this window: open its result to save it again or copy it. If the window closes first, it is lost, and you can run it again.',
			tone: 'error',
		};
	return {
		label: 'On this browser',
		detail:
			'Your recordings are kept in this browser’s storage for this site. They never upload; signing in only adds hosted transcription and AI.',
		tone: 'neutral',
	};
}
