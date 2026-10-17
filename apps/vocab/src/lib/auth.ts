import {
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { APPS, resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

// Vocab's account calls are inference, served by the API audience, and the
// profile read from userinfo, which answers the email only under `email`.
export const auth = createBrowserOAuth({
	server,
	clientId: APPS.VOCAB.id,
	resource: resolveOAuthAudiences(server.baseURL).api,
	scope: 'openid profile email ai',
	accountManagement: !SELF_HOST_ORIGIN,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth[Symbol.dispose]());

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
