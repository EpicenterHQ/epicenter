import { serveBrowserWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { todosWorkspaceDefinition } from './definition.js';

serveBrowserWorkspaceWorker(todosWorkspaceDefinition, {
	onSyncError() {
		// Todos is local-only today; a future server runtime must own this sink.
	},
	onError: reportError,
});
