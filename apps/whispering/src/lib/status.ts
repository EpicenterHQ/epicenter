/**
 * The plain-language status line the header shows for the view that is
 * open (decision 76). "On this device" is this browser's files, signed in
 * or not; signed in, they upload on their own and move to "Synced", which
 * is the person's repository: synced, out of reach, or waiting for a sign-in
 * to be renewed. An answer whose result could not be kept outranks all of
 * these.
 */
import type { StatusLine } from '@epicenter/svelte/status-line';
import type { View } from './files.svelte.js';

export function headerStatus(state: {
	/** Which view is open. */
	readonly view: View;
	/** Answers that arrived in this view and whose result note could not be created. */
	readonly unwrittenAnswers: number;
	/** The account: signed out, signed in, or signed in but needing renewal. */
	readonly auth: 'signed-out' | 'signed-in' | 'reauth-required';
	/** Why this view's files cannot be listed now, if they cannot. */
	readonly problem: string | undefined;
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
	if (state.view === 'device')
		return {
			label: 'On this device',
			detail:
				state.auth === 'signed-out'
					? 'Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.'
					: 'Kept in this browser until they upload to your repository on their own; then they are under Synced.',
			tone: 'neutral',
		};
	if (state.auth === 'reauth-required')
		return {
			label: 'Sign in again',
			detail: 'Sign in again to upload and to edit your repository.',
			tone: 'warning',
		};
	if (state.problem !== undefined)
		return {
			label: 'Offline',
			detail: `Your repository cannot be reached: ${state.problem}. New recordings are kept on this device and upload when it can be.`,
			tone: 'warning',
		};
	return { label: 'Synced', tone: 'good' };
}
