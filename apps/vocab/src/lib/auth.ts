/**
 * `#platform/auth` in the web build: a browser OAuth client whose one
 * sign-in covers both of Vocab's audiences (decision 65): the API, for the
 * hosted tutor and the profile read from userinfo (which answers the email
 * only under `email`), and Git, where the learner's `vocab` repository lives
 * (`openRemote`). `account.fetch` picks each request's token. The desktop
 * window's is `auth.tauri.ts`.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { APPS, resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import type { VocabAuth } from './platform.js';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

const audiences = resolveOAuthAudiences(server.baseURL);
const client = createBrowserOAuth({
	server,
	clientId: APPS.VOCAB.id,
	resources: [audiences.api, audiences.git],
	scope: 'openid profile email ai folders:read folders:write',
	accountManagement: !SELF_HOST_ORIGIN,
});

/** The browser client itself, which also completes a sign-in on `/auth/callback`. */
export const browserAuth = fromAuth(client);

export const auth: VocabAuth = Object.assign(browserAuth, {
	purpose: {
		signedOut:
			'Sign in to use the words and chats in your Epicenter repository.',
		signedIn:
			"Your words and chats are in your Epicenter repository, vocab, where your other devices and Epicenter's desktop app reach them. Nothing is kept in this browser. This account also provides hosted tutor models and dictation.",
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => client[Symbol.dispose]());

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
