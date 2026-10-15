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

// The Git audience with `folders:write`: Todos' only account call is
// `POST /api/git/connect`, which the server authorizes with that audience and
// scope (the API audience does not allow `folders:write`, ADR-0549), and the
// direct Git push uses the same audience.
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
