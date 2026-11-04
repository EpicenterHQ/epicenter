/**
 * `#platform/account` in the web build: the optional sign-in with
 * Epicenter. It grants capabilities only, the Epicenter account route for
 * transcription and AI, so its one token is for the server's API audience
 * with the `ai` scope. It asks for no Git audience and no `folders:*`
 * scope: Whispering's web build keeps its recordings in this browser and
 * never opens a repository (ADR-0700). The desktop window's is
 * `account.tauri.ts`.
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
import { APPS, resolveOAuthAudiences } from '@epicenter/definition/site';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';

/** This page's sign-in. Making it reads `localStorage`; it renews nothing on a timer. */
export function connectAccount(): CallbackAuthClient {
	const server = SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API);
	return createBrowserOAuth({
		server,
		clientId: APPS.WHISPERING.id,
		resources: [resolveOAuthAudiences(server.baseURL).api],
		scope: 'openid profile email ai',
		accountManagement: !SELF_HOST_ORIGIN,
		// A timer must not navigate away in the middle of a recording.
		automaticRenewal: false,
	});
}
