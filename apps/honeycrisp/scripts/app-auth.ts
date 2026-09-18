/** Fixed self-hosted issuer for the disposable browser fixture; never a production entrypoint. */
import type { AuthStartup } from '@epicenter/auth';
import { normalizeInstanceServer } from '@epicenter/auth';
import { createBrowserRedirectAuth } from '../../../packages/auth/src/browser-redirect-auth.js';

const origin = import.meta.env.VITE_HONEYCRISP_TEST_ORIGIN;
if (!origin)
	throw new Error('The browser fixture requires its fixed issuer origin.');

const auth = createBrowserRedirectAuth({
	...normalizeInstanceServer(origin),
	appId: 'so.epicenter.honeycrisp',
	supportsShared: true,
});

export const authStartup: AuthStartup = {
	auth,
	selectedServer: auth.baseURL,
	[Symbol.dispose]() {
		auth[Symbol.dispose]();
	},
};
