import { serveBrowserWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './definition.js';

serveBrowserWorkspaceWorker(workspaceDefinition, {
	pollIntervalMs: 10,
	onSyncError() {
		// The smoke deliberately exercises offline retry and reconnect.
	},
	onError: reportError,
});
