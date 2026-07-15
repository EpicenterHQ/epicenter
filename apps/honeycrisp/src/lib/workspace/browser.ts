/**
 * Honeycrisp browser composition: the one boot call (ADR-0088/ADR-0094).
 *
 * Auth is projected once into a local or server authority. Both branches open
 * the same version-locked contract; the shared browser opener owns SQLite,
 * KV, child-document persistence, synchronization, and teardown.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { honeycrispWorkspaceDefinition } from '../../versions/v1/definition.js';
import WorkspaceWorker from '../../versions/v1/workspace.worker?worker';
import { createHoneycrispActions } from './actions.js';

export async function openHoneycrispBrowser({
	auth,
}: {
	auth: SyncAuthClient;
}) {
	const workspace = await openBrowserWorkspace(honeycrispWorkspaceDefinition, {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
		connection: toWorkspaceConnection(auth),
	});
	return {
		...workspace,
		actions: createHoneycrispActions(workspace),
	};
}

export type HoneycrispBrowser = Awaited<
	ReturnType<typeof openHoneycrispBrowser>
>;
