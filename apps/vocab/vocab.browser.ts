/**
 * Vocab browser composition: the one boot call (ADR-0088/ADR-0094).
 *
 * Auth is projected once into a local or server authority. Both branches open
 * the same version-locked contract; the shared browser opener owns SQLite,
 * KV, child-document persistence, synchronization, and teardown.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceAuthority } from '@epicenter/svelte/auth';
import type { NodeId } from '@epicenter/workspace';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { vocabWorkspaceDefinition } from './src/versions/v1/definition.js';
import WorkspaceWorker from './src/versions/v1/workspace.worker?worker';

export async function openVocabBrowser({
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
	if (authority.kind === 'server') {
		return openBrowserWorkspace(vocabWorkspaceDefinition, {
			...common,
			authority,
			fetch: auth.fetch,
			documentSync: {
				nodeId,
				openWebSocket: auth.openWebSocket,
				onReconnectSignal: auth.onStateChange,
			},
		});
	}
	return openBrowserWorkspace(vocabWorkspaceDefinition, {
		...common,
		authority,
	});
}

export type VocabBrowser = Awaited<ReturnType<typeof openVocabBrowser>>;
