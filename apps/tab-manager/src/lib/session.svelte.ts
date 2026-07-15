/**
 * Boot-time Tab Manager client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `chrome.storage.local` is async, so unlike Honeycrisp's synchronous
 * top-level singleton, everything here is deferred-init: the reactive auth
 * client, the workspace bundle (`openTabManagerBrowser`'s connection branch,
 * see `tab-manager/extension.ts`), and the composed app state are all built
 * exactly once inside `whenReady`, after the persisted auth cell and instance
 * setting resolve. `reloadOnPrincipalChange` is wired the
 * moment the auth client exists, so an identity change reloads the sidepanel
 * document and the next boot re-runs the preset branch.
 *
 * The workspace is never `null` once ready: there is no `require*()`
 * accessor. `App.svelte` mounts its whole tree under
 * `{#await tabManagerBoot.whenReady}`, so by the time a descendant reads
 * `tabManagerBoot.tabManager` the bundle is guaranteed to exist; the getter's
 * throw is a boot-order guard, not a signed-out branch.
 */

import { createAgentChatState } from '@epicenter/app-shell/agent-chat';
import type { InstanceSetting, SyncAuthClient } from '@epicenter/auth';
import { EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID } from '@epicenter/constants/oauth-clients';
import {
	createAppAuthClient,
	reloadOnPrincipalChange,
} from '@epicenter/svelte/auth';
import {
	createLocalToolCatalog,
	defaultApprovalDecision,
} from '@epicenter/workspace/agent';
import { DEFAULT_MODEL } from './chat/models';
import { TAB_MANAGER_SYSTEM_PROMPT } from './chat/system-prompt';
import { createTabManagerSignInMigration } from './migration/sign-in-migration';
import {
	instanceSettingPromise,
	oauthLauncher,
	persistedAuthStoragePromise,
} from './platform/auth';
import { createBookmarkState } from './state/bookmark-state.svelte';
import { inferenceConnections } from './state/inference-connections.svelte';
import { createSavedTabState } from './state/saved-tab-state.svelte';
import { createToolTrustState } from './state/tool-trust.svelte';
import { createUnifiedViewState } from './state/unified-view-state.svelte';
import { openTabManagerBrowser } from './tab-manager/extension';

/** The composed app state layered onto the connected workspace bundle. */
type TabManagerState = {
	savedTabs: ReturnType<typeof createSavedTabState>;
	bookmarks: ReturnType<typeof createBookmarkState>;
	toolTrust: ReturnType<typeof createToolTrustState>;
	unifiedView: ReturnType<typeof createUnifiedViewState>;
	aiChat: ReturnType<typeof createAgentChatState>;
};

/** Everything a component reads once the boot promise resolves. */
export type TabManagerBundle = ReturnType<typeof buildTabManager>;

let authClient: SyncAuthClient | undefined;
let instanceSettingValue: InstanceSetting | undefined;
let bundle: TabManagerBundle | undefined;
let signInMigrationValue:
	| ReturnType<typeof createTabManagerSignInMigration>
	| undefined;

const whenReady = Promise.all([
	persistedAuthStoragePromise,
	instanceSettingPromise,
]).then(([persistedAuthStorage, instanceSetting]) => {
	// One choke point: the persisted instance picks hosted OAuth vs a self-host
	// token (ADR-0071). The launcher is the hosted-constant extension launcher,
	// used only by the OAuth branch.
	const auth = createAppAuthClient(instanceSetting.read(), {
		clientId: EPICENTER_TAB_MANAGER_OAUTH_CLIENT_ID,
		persistedAuthStorage,
		launcher: oauthLauncher,
	});
	authClient = auth;
	instanceSettingValue = instanceSetting;
	bundle = buildTabManager(auth);
	signInMigrationValue = createTabManagerSignInMigration(auth, bundle);
	// Option A (ADR-0088): the doc is picked once at boot (the preset branch
	// inside `openTabManagerBrowser`); a principal identity change reloads the
	// sidepanel document so the next boot rebuilds the right doc.
	reloadOnPrincipalChange(auth);
});

function buildTabManager(auth: SyncAuthClient) {
	const tabManager = openTabManagerBrowser({ auth });

	const savedTabs = createSavedTabState(tabManager);
	const bookmarks = createBookmarkState(tabManager);
	const toolTrust = createToolTrustState(tabManager);
	const unifiedView = createUnifiedViewState({ bookmarks, savedTabs });
	// The shared chat registry (ADR-0047/0059) with tab-manager's variation
	// injected: device-constraint + base prompts read per turn, its in-process
	// browser actions as the tool surface, and the "Always Allow" trust set
	// folded into the approval policy.
	const aiChat = createAgentChatState({
		table: tabManager.tables.conversations,
		whenLoaded: tabManager.storage.whenLoaded,
		connections: inferenceConnections,
		agent: {
			buildSystemPrompts: () => [TAB_MANAGER_SYSTEM_PROMPT],
			defaultModel: DEFAULT_MODEL,
			toolCatalog: createLocalToolCatalog(tabManager.actions),
			// A tool the user chose to "Always Allow" auto-approves; otherwise a
			// query runs unattended and a mutation asks (ADR-0044).
			decideApproval: (call, definition) =>
				toolTrust.shouldAutoApprove(call.toolName)
					? 'auto'
					: defaultApprovalDecision(call, definition),
		},
	});
	const state: TabManagerState = {
		savedTabs,
		bookmarks,
		toolTrust,
		unifiedView,
		aiChat,
	};

	return {
		...tabManager,
		state,
		/** Resolves when local persistence has hydrated the root doc. */
		whenReady: tabManager.storage.whenLoaded,
		[Symbol.dispose]() {
			aiChat[Symbol.dispose]();
			tabManager[Symbol.dispose]();
		},
	};
}

export const tabManagerBoot = {
	get auth(): SyncAuthClient {
		if (!authClient) {
			throw new Error('[tab-manager] auth read before storage readiness.');
		}
		return authClient;
	},
	get instanceSetting(): InstanceSetting {
		if (!instanceSettingValue) {
			throw new Error(
				'[tab-manager] instanceSetting read before storage readiness.',
			);
		}
		return instanceSettingValue;
	},
	get tabManager(): TabManagerBundle {
		if (!bundle) {
			throw new Error(
				'[tab-manager] tabManagerBoot.tabManager read before storage ' +
					'readiness. Components must mount under ' +
					'`{#await tabManagerBoot.whenReady}`.',
			);
		}
		return bundle;
	},
	get signInMigration(): ReturnType<typeof createTabManagerSignInMigration> {
		if (!signInMigrationValue) {
			throw new Error(
				'[tab-manager] tabManagerBoot.signInMigration read before storage ' +
					'readiness. Components must mount under ' +
					'`{#await tabManagerBoot.whenReady}`.',
			);
		}
		return signInMigrationValue;
	},
	whenReady,
	[Symbol.dispose]() {
		bundle?.[Symbol.dispose]();
		authClient?.[Symbol.dispose]();
	},
};

if (import.meta.hot) {
	import.meta.hot.dispose(() => tabManagerBoot[Symbol.dispose]());
}
