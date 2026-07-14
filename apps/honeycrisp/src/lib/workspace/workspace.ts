import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { foldersTable, notesTable } from './index.js';

export const workspaceCandidate = defineWorkspace({
	appId: 'epicenter-honeycrisp',
	version: 1,
	name: 'honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
});
