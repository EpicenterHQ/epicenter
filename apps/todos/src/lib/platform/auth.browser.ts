import {
	type CallbackAuthClient,
	createBrowserOAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { resolveOAuthAudiences } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import manifest from '../../../epicenter.app.json';

const server = SELF_HOST_ORIGIN
	? selfHostedServer(SELF_HOST_ORIGIN)
	: epicenterCloud(APP_URLS.API);

// The Git audience with `folders:write`: the page's one token reaches the
// repository listing (`GET /api/repos`) and pushes to Git directly (ADR-0546);
// the API audience does not allow `folders:write` (ADR-0549).
export const auth: CallbackAuthClient | undefined = createBrowserOAuth({
	server,
	clientId: manifest.id,
	resource: resolveOAuthAudiences(server.baseURL).git,
	scope: 'openid folders:read folders:write',
	accountManagement: !SELF_HOST_ORIGIN,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
