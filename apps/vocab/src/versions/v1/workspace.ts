import { conversationsTable } from '@epicenter/chat';
import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { entriesTable, showReadings } from '../../../vocab.js';

export const workspaceCandidate = defineWorkspace({
	appId: 'epicenter-vocab',
	version: 1,
	name: 'vocab',
	tables: {
		conversations: conversationsTable,
		entries: entriesTable,
	},
	kv: { showReadings },
});
