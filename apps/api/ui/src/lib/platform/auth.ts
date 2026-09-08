import { createHostedBrowserRedirectAuth } from '@epicenter/auth';
import { fromAuth } from '@epicenter/auth/svelte';
import { DASHBOARD_APP_ID } from '@epicenter/constants/apps';
import {
	dashboardReturnKey,
	readDashboardReturnPath,
} from '../dashboard/navigation.js';

export const authClient = createHostedBrowserRedirectAuth({
	appId: DASHBOARD_APP_ID,
	authorityId: 'epicenter-api',
	baseURL: window.location.origin,
	callbackPath: '/session/callback',
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);

/** Keep account navigation with this tab's sign-in ceremony. */
export async function startDashboardSignIn(
	options?: Parameters<typeof auth.startSignIn>[0],
) {
	window.sessionStorage.setItem(
		dashboardReturnKey,
		readDashboardReturnPath(
			`${window.location.pathname}${window.location.search}${window.location.hash}`,
			window.location.origin,
		),
	);
	return auth.startSignIn(options);
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		authClient[Symbol.dispose]();
	});

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
