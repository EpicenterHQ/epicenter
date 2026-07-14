import { serveBrowserWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { honeycrispWorkspaceDefinition } from './definition.js';

serveBrowserWorkspaceWorker(honeycrispWorkspaceDefinition, {
	onSyncError: reportError,
	onError: reportError,
});
