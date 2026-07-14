/**
 * Honeycrisp browser composition: the one boot call (ADR-0088/ADR-0094).
 *
 * Auth is projected once into a local or server authority. Both branches open
 * the same version-locked contract; the shared browser opener owns SQLite,
 * KV, child-document persistence, synchronization, and teardown.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceAuthority } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { createHoneycrispActions } from './actions.js';
import { honeycrispWorkspaceDefinition } from './definition.js';
import WorkspaceWorker from './workspace.worker?worker';

export async function openHoneycrispBrowser({
	auth,
	nodeId,
}: {
	auth: SyncAuthClient;
	nodeId: NodeId;
}) {
	const authority = toWorkspaceAuthority(auth);
	const common = {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
	};
	const workspace =
		authority.kind === 'server'
			? await openBrowserWorkspace(honeycrispWorkspaceDefinition, {
					...common,
					authority,
					fetch: auth.fetch,
					documentSync: {
						nodeId,
						openWebSocket: auth.openWebSocket,
						onReconnectSignal: auth.onStateChange,
					},
				})
			: await openBrowserWorkspace(honeycrispWorkspaceDefinition, {
					...common,
					authority,
				});
	return {
		...workspace,
		actions: createHoneycrispActions(workspace),
	};
}

export type HoneycrispBrowser = Awaited<
	ReturnType<typeof openHoneycrispBrowser>
>;
