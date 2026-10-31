/**
 * `#platform/auth` in Whispering's desktop window: the optional sign-in
 * with Epicenter, through the shell (`epicenter-account`). It grants
 * capabilities only, Epicenter's hosted transcription and AI; the recordings
 * stay in the data folder either way. The shell signs in through the system
 * browser, keeps the refresh token in the keychain, and sends each of the
 * account's requests itself (`account_fetch`), so this page never holds a
 * token. Made on first use.
 */
import { fromAuth } from '@epicenter/auth/svelte';
import { createTauriAuth } from '@epicenter/auth/tauri';
import type { PlatformAuth } from './types.js';

let made: { auth: PlatformAuth; ready: Promise<void> } | undefined;

function make() {
	if (made) return made;
	const { client, ready } = createTauriAuth();
	made = { auth: fromAuth(client), ready };
	return made;
}

export function getAuth(): PlatformAuth {
	return make().auth;
}

/** Resolves once the shell said who, if anyone, is signed in; until then `baseURL` is empty. */
export function authReady(): Promise<void> {
	return make().ready;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => made?.auth[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
