import { serveStandaloneWorkspaceWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './definition.js';

serveStandaloneWorkspaceWorker(workspaceDefinition, {
	onError: reportError,
});
