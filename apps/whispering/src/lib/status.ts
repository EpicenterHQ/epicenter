/**
 * The plain-language status line the header shows: whether what the person
 * did is in the folder on this device.
 *
 * The folder keeps no versions and does not sync here, so the line reports
 * saving alone: a save running, typing that did not save, an answer whose
 * file could not be written yet, or the last save storage refused.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

/** What is saved to files: saves running or kept after a failure, and answers whose write failed. */
export function filesLine(state: {
	readonly saving: boolean;
	/** Typing is kept in this window because its save failed. */
	readonly unsaved?: boolean;
	/** Why storage refused the last save, until a save lands. */
	readonly storageFailure?: string;
	/** Answers that arrived and whose result file could not be written yet. */
	readonly unwrittenAnswers: number;
}): StatusLine {
	const unwritten = state.unwrittenAnswers;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not written yet`,
			short: 'Answer not written',
			detail:
				'Whispering keeps writing it while this window is open. If the window closes first, its file stays without the answer, and you can run it again.',
			tone: 'error',
		};
	if (state.unsaved)
		return {
			label: 'An edit is not saved yet',
			short: 'Not saved',
			detail:
				'Its save failed. The edit is kept in this window and is saved again with your next change to it, or when you try again.',
			tone: 'error',
		};
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	if (state.storageFailure !== undefined)
		return {
			label: 'A save failed',
			detail: state.storageFailure,
			tone: 'error',
		};
	return {
		label: 'All changes saved on this device',
		short: 'Saved',
		tone: 'good',
	};
}
