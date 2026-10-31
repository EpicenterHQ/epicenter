/**
 * This browser tab's sign-in with Epicenter, which is optional: it grants
 * capabilities only, the Epicenter account route for transcription and AI,
 * so its one token is for the server's API audience with the `ai` scope.
 * It asks for no Git audience and no `folders:*` scope: Whispering's web
 * build keeps its recordings in this browser and never opens a repository
 * (ADR-0700). Created on first use so the callback can use it without
 * opening any files.
 */
import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { APPS, resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import type { PlatformAuth } from './types.js';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

let auth: PlatformAuth | undefined;

export function getAuth(): PlatformAuth {
	if (auth) return auth;
	const client = createBrowserOAuth({
		server,
		clientId: APPS.WHISPERING.id,
		resources: [resolveOAuthAudiences(server.baseURL).api],
		scope: 'openid profile email ai',
		accountManagement: !SELF_HOST_ORIGIN,
		// A timer must not navigate away in the middle of a recording.
		automaticRenewal: false,
	});
	auth = fromAuth(client);
	return auth;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
