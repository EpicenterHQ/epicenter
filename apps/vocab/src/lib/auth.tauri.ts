/**
 * `#platform/auth` in Vocab's desktop window: the optional sign-in with
 * Epicenter, through the shell (`epicenter-account`, as
 * `so.epicenter.vocab.native`). It grants capabilities only, Epicenter's
 * hosted tutor models and dictation; the words and chats stay in the data
 * folder either way. The shell signs in through the system browser, keeps
 * the refresh token in the keychain, and sends each of the account's
 * requests itself (`account_fetch`), so this page never holds a token.
 */
import { fromAuth } from '@epicenter/auth/svelte';
import { createTauriAuth } from '@epicenter/auth/tauri';
import type { VocabAuth } from './platform.js';

const { client, ready } = createTauriAuth();

export const auth: VocabAuth = Object.assign(fromAuth(client), {
	purpose: {
		signedOut:
			"Your words and chats are Markdown files in Vocab's folder on this computer, with no sign-in. Signing in with Epicenter adds its hosted tutor models and dictation.",
		signedIn:
			"Your words and chats stay in Vocab's folder on this computer. This account provides Epicenter's hosted tutor models and dictation.",
	},
});

/** Resolves once the shell said who, if anyone, is signed in; until then the page reads signed out. */
export const authReady: Promise<void> = ready;

if (import.meta.hot) {
	import.meta.hot.dispose(() => client[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
