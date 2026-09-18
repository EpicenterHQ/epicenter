import {
	createHostedBrowserRedirectAuth,
	type AuthStartup,
} from '@epicenter/auth';
import { APPS } from '@epicenter/constants/apps';
import { APP_URLS } from '@epicenter/constants/vite';

const auth = createHostedBrowserRedirectAuth({
	appId: APPS.HONEYCRISP.id,
	baseURL: APP_URLS.API,
});

export const authStartup = {
	auth,
	selectedServer: null,
	[Symbol.dispose]() {
		auth[Symbol.dispose]();
	},
} satisfies AuthStartup;

if (import.meta.hot) {
	import.meta.hot.dispose(() => authStartup[Symbol.dispose]());

	// `accept` is what makes the `dispose` run. Vite disposes only the module an
	// update was ACCEPTED at, so a leaf with a disposer and no accept is never
	// one: the update walks up to the nearest self-accepting importer and that
	// module's disposer runs instead, leaving this client's credential
	// authority alive beside its replacement. Invalidating immediately hands
	// the update back up exactly as before, with this leaf released first.
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
