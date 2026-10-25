/**
 * The plain-language status line the header shows: whether what the person
 * did is in the folder on this device.
 *
 * The folder keeps no versions and does not sync here, so the line reports
 * saving alone: a save running, or an answer whose file could not be
 * written. A save that fails is its own notice, with the text to copy.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

/** What is saved to files: saves running, and answers whose write failed. */
export function filesLine(state: {
	readonly saving: boolean;
	/** Answers that arrived and whose result file could not be written. */
	readonly unwrittenAnswers: number;
}): StatusLine {
	const unwritten = state.unwrittenAnswers;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not written yet`,
			short: 'Answer not written',
			detail:
				'The answer is kept in this window: open its result to save it again or copy it. If the window closes first, its file stays without the answer, and you can run it again.',
			tone: 'error',
		};
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	return {
		label: 'All changes saved on this device',
		short: 'Saved',
		tone: 'good',
	};
}
