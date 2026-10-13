import {
	createBrowserRedirectAuth,
	epicenterCloud,
	selfHostedServer,
	type CallbackAuthClient,
} from '@epicenter/auth';
import { APPS } from '@epicenter/constants/apps';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';

export const auth: CallbackAuthClient | undefined = createBrowserRedirectAuth({
	appId: APPS.TODOS.id,
	server: SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API),
	accountManagement: !SELF_HOST_ORIGIN,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
