import { fromAuth } from '@epicenter/auth/svelte';
import { createCookieSessionAuth } from '../auth/cookie-session.js';
import { readDashboardReturnPath } from '../dashboard/navigation.js';

export const authClient = createCookieSessionAuth({
	origin: window.location.origin,
	navigate: (url) => window.location.assign(url),
	returnPath: () =>
		readDashboardReturnPath(
			`${window.location.pathname}${window.location.search}${window.location.hash}`,
			window.location.origin,
		),
});

// Boot code takes `authClient`; a component that must track takes `auth`.
export const auth = fromAuth(authClient);

/** Settles once the first cookie session read has decided the state. */
export const authReady = authClient.refresh();

// Another tab can sign in as someone else or sign out. Coming back reads the
// cookie again, so a dashboard never keeps showing a person it no longer has.
const recheck = () => {
	if (document.visibilityState === 'visible') void authClient.refresh();
};
window.addEventListener('focus', recheck);
document.addEventListener('visibilitychange', recheck);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		window.removeEventListener('focus', recheck);
		document.removeEventListener('visibilitychange', recheck);
		authClient[Symbol.dispose]();
	});

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's listeners alive
	// beside its replacement. Invalidating immediately hands the update back up
	// exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
