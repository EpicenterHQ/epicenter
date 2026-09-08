/**
 * `#platform/gmail-authorization` inside the trusted Epicenter origin.
 *
 * Two native refusals shape this leaf. The window's navigation guard admits
 * only the host's loopback origin, so Google's consent screen has to open
 * outside it, which is a scoped `opener` grant this window holds for
 * `accounts.google.com` and nothing else. And Google refuses a custom URI
 * scheme for a Desktop OAuth client, so it answers on the host's socket in the
 * person's own browser rather than here.
 *
 * The host holds that answer and this page collects it. Nothing is written
 * down, because this page never leaves: the caller still holds the request, and
 * redemption stays here because the PKCE verifier is here. The host never reads
 * the code, never talks to Google, and never sees the refresh token.
 */

import {
	PENDING_CALLBACK_PATH,
	type PendingCallback,
} from '@epicenter/local-mail/authorization-return';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { GmailAuthorization } from './types';

/**
 * How long to wait for a person to finish with Google before giving up.
 *
 * Generous, because the wait covers choosing an account, a password, and a
 * second factor. It exists so a person who abandoned the tab gets a button back
 * instead of a spinner forever.
 */
const AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;

export const gmailAuthorization: GmailAuthorization = {
	async authorize(request, signal) {
		signal.throwIfAborted();
		// Discard whatever an abandoned attempt left behind. Without this, a
		// callback nobody redeemed would be handed to this attempt instead of
		// its own, which fails the `state` check and strands the real answer.
		await collect(signal);
		signal.throwIfAborted();
		await openUrl(request.authorizeUrl);
		const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const pending = await collect(signal);
			if (pending !== null) return new URL(pending.callbackUrl);
			await new Promise<void>((resolve, reject) => {
				signal.throwIfAborted();
				const abort = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener('abort', abort);
					resolve();
				}, POLL_INTERVAL_MS);
				signal.addEventListener('abort', abort, { once: true });
			});
		}
		throw new Error(
			'Google did not answer. Close the browser tab and try connecting again.',
		);
	},
};

/** The callback the host is holding, or nothing yet. */
async function collect(signal: AbortSignal): Promise<PendingCallback | null> {
	const response = await fetch(PENDING_CALLBACK_PATH, {
		cache: 'no-store',
		signal,
	});
	if (response.status === 204) return null;
	if (!response.ok) {
		throw new Error(
			`Epicenter could not report Google's answer (${response.status}).`,
		);
	}
	return (await response.json()) as PendingCallback;
}
