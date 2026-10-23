/** This browser tab's OAuth client. Created on first use so the callback can use it without opening a folder. */
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
		resource: resolveOAuthAudiences(server.baseURL).api,
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
