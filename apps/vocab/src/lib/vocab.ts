/**
 * Boot-time Vocab client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `openVocabBrowser` reads the persisted `auth.state` once at startup and
 * opens either local storage or the principal's synchronized storage,
 * including per-conversation message documents. Construction and initial row
 * projections complete before the layout renders. Identity changes are never an
 * in-place swap: `reloadOnPrincipalChange` (mounted in the root layout) reloads
 * the page so the next boot re-runs this selection.
 *
 * The workspace is never nullable.
 */

import { openVocabBrowser } from '@epicenter/vocab/browser';
import { auth } from '$lib/platform/auth';
import { createVocabState } from '$lib/state/index.svelte';

const browser = await openVocabBrowser({ auth });
const state = createVocabState(browser);

export const vocab = {
	...browser,
	state,
	/** Resolves after both live SQLite projections have their initial state. */
	whenReady: state.whenReady,
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		state[Symbol.dispose]();
		void browser[Symbol.asyncDispose]();
	});
}
