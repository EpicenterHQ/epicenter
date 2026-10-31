/**
 * Sign-in with Epicenter for Todos' web build: a browser OAuth client
 * whose one token is for the server's Git audience, where the person's
 * `todos` repository lives. Todos makes no inference calls, so it asks for
 * no API token.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it (a local or
 * self-hosted API), otherwise Epicenter's.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

const client = createBrowserOAuth({
	server,
	clientId: 'so.epicenter.todos',
	resources: [resolveOAuthAudiences(server.baseURL).git],
	scope: 'openid folders:read folders:write',
	accountManagement: !SELF_HOST_ORIGIN,
});

export const auth = fromAuth(client);

if (import.meta.hot) {
	import.meta.hot.dispose(() => client[Symbol.dispose]());
	// Hand the update up, with this client released first (see apps/vocab's auth).
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
