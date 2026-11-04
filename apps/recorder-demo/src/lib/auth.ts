/**
 * Sign-in with Epicenter for the demo's online variant: a browser OAuth
 * client whose token is for the server's Git audience, which is where the
 * repository lives. Only `/online` and `/auth/callback` load this module;
 * the local variant needs no account, so it never makes the client.
 *
 * The server is `VITE_EPICENTER_SERVER` when the build sets it, otherwise
 * the local Bun API (`apps/api`, port 8788): the hosted API does not serve
 * web writes yet. Either way the demo is the local-only client
 * `so.epicenter.recorder-demo`, which only a local deployment registers.
 */
import { createBrowserOAuth, selfHostedServer } from '@epicenter/account';
import {
	API_BUN_DEV_PORT,
	LOCAL_APPS,
	localUrl,
	resolveOAuthAudiences,
} from '@epicenter/definition/site';
import { reactive } from '@epicenter/svelte/reactive';
import { SELF_HOST_ORIGIN } from '@epicenter/vite-config/app-urls';

const server = selfHostedServer(
	SELF_HOST_ORIGIN ?? localUrl({ port: API_BUN_DEV_PORT }),
);

const client = createBrowserOAuth({
	server,
	clientId: LOCAL_APPS.RECORDER_DEMO.id,
	resources: [resolveOAuthAudiences(server.baseURL).git],
	scope: 'openid folders:read folders:write',
	accountManagement: false,
});

/** The sign-in, read through `reactive`: its `state()` tracks in Svelte. */
export const auth = reactive(client);

if (import.meta.hot) {
	import.meta.hot.dispose(() => client[Symbol.dispose]());
	// Hand the update up, with this client released first (see apps/vocab's auth).
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
