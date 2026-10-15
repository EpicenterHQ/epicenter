import {
	type CallbackAuthClient,
	createBrowserRedirectAuth,
	epicenterCloud,
	selfHostedServer,
} from '@epicenter/auth';
import { APP_URLS, SELF_HOST_ORIGIN } from '@epicenter/constants/vite';
import manifest from '../../../epicenter.app.json';

export const auth: CallbackAuthClient | undefined = createBrowserRedirectAuth({
	appId: manifest.id,
	server: SELF_HOST_ORIGIN
		? selfHostedServer(SELF_HOST_ORIGIN)
		: epicenterCloud(APP_URLS.API),
	accountManagement: !SELF_HOST_ORIGIN,
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => auth?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
