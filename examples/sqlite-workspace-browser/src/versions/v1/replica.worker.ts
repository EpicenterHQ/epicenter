import { createHttpReplicaSyncPort } from '@epicenter/workspace/sqlite';
import { serveWorkspaceReplicaWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './definition.js';

const syncOrigin = new URL(self.location.href);
syncOrigin.port = '5199';

serveWorkspaceReplicaWorker(workspaceDefinition, {
	sync: createHttpReplicaSyncPort({ baseUrl: syncOrigin.origin, fetch }),
	pollIntervalMs: 10,
	onSyncError: reportError,
	onError: reportError,
});
