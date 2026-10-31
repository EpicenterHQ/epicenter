/**
 * The plain-language status line the header shows: where the person's files
 * are. Signed out, everything is in this browser. Signed in, what this
 * browser made uploads to the repository on its own, so the line says how
 * much is still waiting, or that the repository cannot be reached. An
 * answer whose result could not be kept outranks all of these.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';

export function headerStatus(state: {
	/** Answers that arrived and whose result note could not be created. */
	readonly unwrittenAnswers: number;
	/** Whether someone is signed in, so a repository is open. */
	readonly signedIn: boolean;
	/** Notes and recordings still on this device, not uploaded yet. */
	readonly waiting: number;
	/** Why the repository cannot be listed now, if it cannot. */
	readonly repositoryProblem: string | undefined;
}): StatusLine {
	const { unwrittenAnswers: unwritten, waiting } = state;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not saved yet`,
			short: 'Answer not saved',
			detail:
				'The answer is kept in this window: open its result to save it again or copy it. If the window closes first, it is lost, and you can run it again.',
			tone: 'error',
		};
	if (!state.signedIn)
		return {
			label: 'In this browser',
			detail:
				'Your recordings are kept in this browser. Sign in to keep them in your Epicenter repository; what is here uploads then.',
			tone: 'neutral',
		};
	if (state.repositoryProblem !== undefined)
		return {
			label: 'Repository unreachable',
			short: 'Offline',
			detail: `Your repository cannot be reached: ${state.repositoryProblem}. What you make is kept in this browser and uploads when it can.`,
			tone: 'warning',
		};
	if (waiting > 0)
		return {
			label: `${waiting} not uploaded yet`,
			short: 'Uploading',
			detail: 'Kept in this browser until it reaches your repository.',
			tone: 'busy',
		};
	return { label: 'In your repository', tone: 'good' };
}
