import { serveBrowserWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { tabManagerWorkspaceDefinition } from './definition.js';

serveBrowserWorkspaceWorker(tabManagerWorkspaceDefinition, {
	onSyncError: reportError,
	onError: reportError,
});
