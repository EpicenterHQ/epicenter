/** Fixed self-hosted issuer for the disposable browser fixture; never a production entrypoint. */
import { selfHostedServer } from '@epicenter/auth';
import { createBrowserRedirectAuth } from '../../../packages/auth/src/browser-redirect-auth.js';

const origin = import.meta.env.VITE_HONEYCRISP_TEST_ORIGIN;
if (!origin)
	throw new Error('The browser fixture requires its fixed issuer origin.');

export const auth = createBrowserRedirectAuth({
	server: selfHostedServer(origin),
	appId: 'so.epicenter.honeycrisp',
});
