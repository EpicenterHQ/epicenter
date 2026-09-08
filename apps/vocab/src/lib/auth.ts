import { createHostedBrowserRedirectAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { APPS } from '@epicenter/constants/apps';
import { APP_URLS } from '@epicenter/constants/vite';

export const authClient = createHostedBrowserRedirectAuth({
	appId: APPS.VOCAB.id,
	authorityId: 'epicenter-api',
	baseURL: APP_URLS.API,
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);

if (import.meta.hot) {
	import.meta.hot.dispose(() => authClient[Symbol.dispose]());

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
