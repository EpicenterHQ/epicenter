/**
 * `#platform/account` in Vocab's desktop window: the optional sign-in with
 * Epicenter, through the shell (`epicenter-account`, as
 * `so.epicenter.vocab.native`). It grants capabilities only, Epicenter's
 * hosted tutor models and dictation; the words and chats stay in the data
 * folder either way, which `openFolder` opens whatever account it is given.
 * The shell signs in through the system browser, keeps the refresh token in
 * the keychain, and sends each of the account's requests itself
 * (`account_fetch`), so this page never holds a token. The page reads
 * signed out until the shell answers who, if anyone, is signed in.
 */
import type { AuthClient } from '@epicenter/account';
import { createTauriAuth } from '@epicenter/account/tauri';

/** This window's sign-in, through the shell. */
export function connectAccount(): AuthClient {
	return createTauriAuth().client;
}

/**
 * What the account does in this build, in the learner's words. On the
 * desktop it is optional: the words and chats are in the data folder.
 */
export const accountPurpose = {
	required: false,
	signedOut:
		"Your words and chats are Markdown files in Vocab's folder on this computer, with no sign-in. Signing in with Epicenter adds its hosted tutor models and dictation.",
	signedIn:
		"Your words and chats stay in Vocab's folder on this computer. This account provides Epicenter's hosted tutor models and dictation.",
};
