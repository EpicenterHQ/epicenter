/**
 * Vocab browser composition: the one boot call (ADR-0088/ADR-0094).
 *
 * Auth is projected once into a local or server authority. Both branches open
 * the same version-locked contract; the shared browser opener owns SQLite,
 * KV, child-document persistence, synchronization, and teardown.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { vocabWorkspaceDefinition } from './src/versions/v1/definition.js';
import WorkspaceWorker from './src/versions/v1/workspace.worker?worker';

export async function openVocabBrowser({ auth }: { auth: SyncAuthClient }) {
	return openBrowserWorkspace(vocabWorkspaceDefinition, {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
		connection: toWorkspaceConnection(auth),
	});
}

export type VocabBrowser = Awaited<ReturnType<typeof openVocabBrowser>>;
