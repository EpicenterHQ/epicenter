/** Boot-time auth, SQLite workspace, and app-state composition. */

import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import {
	createAppAuthClient,
	reloadOnPrincipalChange,
} from '@epicenter/svelte/auth';
import { openTabManagerBrowser } from '../../tab-manager.browser.js';
import {
	instanceSettingPromise,
	oauthLauncher,
	persistedAuthStoragePromise,
} from './platform/auth.js';
import { createUnifiedViewState } from './state/unified-view-state.svelte.js';
import { createWebCaptureState } from './state/web-capture-state.svelte.js';

export type TabManagerBundle = Awaited<ReturnType<typeof buildTabManager>>;

let authClient: SyncAuthClient | undefined;
let instanceSettingValue: InstanceSetting | undefined;
let bundle: TabManagerBundle | undefined;

const whenReady = Promise.all([
	persistedAuthStoragePromise,
	instanceSettingPromise,
]).then(async ([persistedAuthStorage, instanceSetting]) => {
	const auth = createAppAuthClient(instanceSetting.read(), {
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	authClient = auth;
	instanceSettingValue = instanceSetting;
	bundle = await buildTabManager(auth);
	reloadOnPrincipalChange(auth);
});

async function buildTabManager(auth: SyncAuthClient) {
	const tabManager = await openTabManagerBrowser({ auth });
	const captures = createWebCaptureState(tabManager);
	const view = createUnifiedViewState(captures);

	return {
		...tabManager,
		state: { captures, view },
		whenReady: captures.whenReady,
		async [Symbol.asyncDispose]() {
			captures[Symbol.dispose]();
			await tabManager[Symbol.asyncDispose]();
		},
	};
}

export const tabManagerBoot = {
	get auth(): SyncAuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before boot readiness.');
		}
		return authClient;
	},
	get instanceSetting(): InstanceSetting {
		if (!instanceSettingValue) {
			throw new Error(
				'[tab-manager] instance setting read before boot readiness.',
			);
		}
		return instanceSettingValue;
	},
	get tabManager(): TabManagerBundle {
		if (!bundle) {
			throw new Error('[tab-manager] workspace read before boot readiness.');
		}
		return bundle;
	},
	whenReady,
	[Symbol.dispose]() {
		if (bundle) void bundle[Symbol.asyncDispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerBoot[Symbol.dispose]());
}
