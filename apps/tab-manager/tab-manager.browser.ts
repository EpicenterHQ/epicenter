import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { browser } from 'wxt/browser';
import { tabManagerWorkspaceDefinition } from './src/versions/v1/definition.js';
import WorkspaceWorker from './src/versions/v1/workspace.worker?worker';
import { createTabManagerActions } from './tab-manager.js';

/** Open Tab Manager version 1 against one boot-time workspace connection. */
export async function openTabManagerBrowser({
	auth,
}: {
	auth: SyncAuthClient;
}) {
	const workspace = await openBrowserWorkspace(tabManagerWorkspaceDefinition, {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
		connection: toWorkspaceConnection(auth),
	});

	return {
		...workspace,
		actions: createTabManagerActions(workspace, {
			async open(url) {
				await browser.tabs.create({ url });
			},
		}),
	};
}

export type TabManagerBrowser = Awaited<
	ReturnType<typeof openTabManagerBrowser>
>;
