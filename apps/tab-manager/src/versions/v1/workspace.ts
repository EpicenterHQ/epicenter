import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { TAB_MANAGER_APP_ID, webCapturesTable } from '../../../tab-manager.js';

export const workspaceCandidate = defineWorkspace({
	appId: TAB_MANAGER_APP_ID,
	version: 1,
	name: 'tab-manager',
	tables: { webCaptures: webCapturesTable },
});
