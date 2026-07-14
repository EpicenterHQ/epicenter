import { serveWorkspaceInspectorWorker } from '@epicenter/workspace/sqlite/browser-worker';
import { workspaceDefinition } from './definition.js';

serveWorkspaceInspectorWorker(workspaceDefinition, 'replica');
