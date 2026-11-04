/**
 * `#platform/account` in the web build: sign-in with Epicenter, a browser
 * OAuth client whose one token is for the server's Git audience, where the
 * person's `capture` repository lives. Capture makes no inference calls, so
 * it asks for no API token. The desktop window's is `account.tauri.ts`: it
 * never signs in.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it (a local or
 * self-hosted API), otherwise Epicenter's.
 */
import {
	type CallbackAuthClient,
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/account';
import { resolveOAuthAudiences } from '@epicenter/definition/site';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';

/** This page's sign-in. Making it reads `localStorage` and schedules renewals. */
export function connectAccount(): CallbackAuthClient | null {
	const server = SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API);
	return createBrowserOAuth({
		server,
		clientId: 'so.epicenter.capture',
		resources: [resolveOAuthAudiences(server.baseURL).git],
		scope: 'openid folders:read folders:write',
		accountManagement: !SELF_HOST_ORIGIN,
	});
}
