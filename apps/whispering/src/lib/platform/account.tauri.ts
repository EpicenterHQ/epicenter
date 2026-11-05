/**
 * `#platform/account` in Whispering's desktop window: the optional sign-in
 * with Epicenter, through the shell (`epicenter-account`). It grants
 * capabilities only, Epicenter's hosted transcription and AI; the
 * recordings stay in the data folder either way. The shell signs in through
 * the system browser, keeps the refresh token in the app's credentials
 * file, and sends each of the account's requests itself (`account_fetch`),
 * so this page never holds a token. Who is signed in is `account.json` in
 * this computer's settings, which the shell writes and the page reads once
 * they connected.
 */
import type { AuthClient } from '@epicenter/account';
import { createTauriAuth } from '@epicenter/account/tauri';

/** This window's sign-in, through the shell. */
export function connectAccount(): AuthClient {
	return createTauriAuth();
}
