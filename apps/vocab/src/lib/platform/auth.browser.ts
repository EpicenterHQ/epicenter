/**
 * Sign-in with Epicenter in the browser (`#platform/auth`'s web leaf): a
 * browser OAuth client whose one sign-in covers both of Vocab's audiences
 * (decision 65), the API, for the hosted tutor and the profile read from
 * userinfo (which answers the email only under `email`), and Git, where the
 * learner's `vocab` repository lives (`openRemote`). `account.fetch` picks
 * each request's token.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { APPS, resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import type { VocabAuth } from './types.js';

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
			"Your words and chats are saved in this browser. Signing in uploads them to your Epicenter repository, shown under Synced, where your other devices and Epicenter's desktop app reach them, and adds Epicenter's hosted tutor models.",
		signedIn:
			'Words and chats saved on this device upload to your repository on their own, then show under Synced. This account also provides hosted tutor models.',
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
