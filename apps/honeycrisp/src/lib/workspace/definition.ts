import { lockWorkspace } from '@epicenter/workspace/sqlite';
import versionLock from '../../../workspace-version-lock.json' with {
	type: 'json',
};
import { workspaceCandidate } from './workspace.js';

export const honeycrispWorkspaceDefinition = lockWorkspace(
	workspaceCandidate,
	versionLock,
);
