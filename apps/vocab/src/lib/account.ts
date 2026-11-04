/**
 * `#platform/account` in the web build: sign-in with Epicenter, a browser
 * OAuth client whose one sign-in covers both of Vocab's audiences (decision
 * 65): the API, for the hosted tutor and dictation and the profile read
 * from userinfo (which answers the email only under `email`), and Git,
 * where the learner's `vocab` repository lives. `account.fetch` picks each
 * request's token. The desktop window's is `account.tauri.ts`.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it (a local or
 * self-hosted API), otherwise Epicenter's.
 */
import {
	type AuthClient,
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/account';
import { APPS, resolveOAuthAudiences } from '@epicenter/definition/site';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';

/**
 * This page's sign-in, which also completes a sign-in on `/auth/callback`.
 * Making it reads `localStorage` and schedules renewals.
 */
export function connectAccount(): AuthClient {
	const server = SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API);
	const audiences = resolveOAuthAudiences(server.baseURL);
	return createBrowserOAuth({
		server,
		clientId: APPS.VOCAB.id,
		resources: [audiences.api, audiences.git],
		scope: 'openid profile email ai folders:read folders:write',
		accountManagement: !SELF_HOST_ORIGIN,
	});
}

/**
 * What the account does in this build, in the learner's words. On the web
 * it holds the words and chats, so a signed-out page asks to sign in.
 */
export const accountPurpose = {
	required: true,
	signedOut: 'Sign in to use the words and chats in your Epicenter repository.',
	signedIn:
		"Your words and chats are in your Epicenter repository, vocab, where your other devices and Epicenter's desktop app reach them. Nothing is kept in this browser. This account also provides hosted tutor models and dictation.",
};
