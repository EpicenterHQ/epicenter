/**
 * Sign-in with Epicenter for Capture: a browser OAuth client whose one
 * token is for the server's Git audience, where the person's `capture`
 * repository lives. Capture makes no inference calls, so it asks for no API
 * token.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it (a local or
 * self-hosted API), otherwise Epicenter's. The client is made on first use:
 * making it reads `localStorage` and schedules renewals.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';

function createAuth() {
	const server = SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API);
	const client = createBrowserOAuth({
		server,
		clientId: 'so.epicenter.capture',
		resources: [resolveOAuthAudiences(server.baseURL).git],
		scope: 'openid folders:read folders:write',
		accountManagement: !SELF_HOST_ORIGIN,
	});
	if (import.meta.hot) import.meta.hot.dispose(() => client[Symbol.dispose]());
	return fromAuth(client);
}

let auth: ReturnType<typeof createAuth> | undefined;

/** This page's sign-in, made on first use. */
export function webAuth() {
	auth ??= createAuth();
	return auth;
}

if (import.meta.hot)
	// Hand the update up, with the client released first (see apps/vocab's auth).
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
