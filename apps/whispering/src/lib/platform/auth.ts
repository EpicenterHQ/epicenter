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
	type AuthClient,
	type CallbackAuthClient,
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/account';
import { APPS, resolveOAuthAudiences } from '@epicenter/definition/site';
import { reactive } from '@epicenter/svelte/reactive';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';
import type { PlatformAuth } from './types.js';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

let made: { account: CallbackAuthClient; auth: PlatformAuth } | undefined;

function make() {
	if (made) return made;
	const client = createBrowserOAuth({
		server,
		clientId: APPS.WHISPERING.id,
		resources: [resolveOAuthAudiences(server.baseURL).api],
		scope: 'openid profile email ai',
		accountManagement: !SELF_HOST_ORIGIN,
		// A timer must not navigate away in the middle of a recording.
		automaticRenewal: false,
	});
	made = { account: client, auth: reactive(client) };
	return made;
}

/** The sign-in itself, which `hosted` reads at every use. */
export function getAccount(): AuthClient {
	return make().account;
}

export function getAuth(): PlatformAuth {
	return make().auth;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => made?.auth[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
