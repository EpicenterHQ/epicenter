/**
 * Sign-in with Epicenter for Todos' web build: a browser OAuth client
 * whose one token is for the server's Git audience, where the person's
 * `todos` repository lives. Todos makes no inference calls, so it asks for
 * no API token.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it (a local or
 * self-hosted API), otherwise Epicenter's.
 *
 * The client is made on first use, and only in a browser: making it reads
 * `localStorage` and schedules renewals, and the desktop window, whose
 * folder Epicenter syncs, never signs in.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import { isDesktop } from './device.js';

function createAuth() {
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
	if (import.meta.hot) import.meta.hot.dispose(() => client[Symbol.dispose]());
	return fromAuth(client);
}

let auth: ReturnType<typeof createAuth> | undefined;

/** This page's sign-in, made on first use; null in the desktop window, which never signs in. */
export function webAuth() {
	if (isDesktop) return null;
	auth ??= createAuth();
	return auth;
}

if (import.meta.hot)
	// Hand the update up, with the client released first (see apps/vocab's auth).
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
