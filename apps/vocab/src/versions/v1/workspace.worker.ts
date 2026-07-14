import { serveBrowserWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { vocabWorkspaceDefinition } from './definition.js';

serveBrowserWorkspaceWorker(vocabWorkspaceDefinition, {
	onSyncError: reportError,
	onError: reportError,
});
