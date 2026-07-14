import { lockWorkspace } from '@epicenter/workspace/sqlite';
import dataVersionLock from '../../../data-version-lock.json' with {
	type: 'json',
};
import { workspaceCandidate } from './workspace.js';

export const workspaceDefinition = lockWorkspace(
	workspaceCandidate,
	dataVersionLock,
);
