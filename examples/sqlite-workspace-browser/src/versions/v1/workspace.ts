import { field } from '@epicenter/field';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	document,
} from '@epicenter/workspace/sqlite';

const notes = defineTable({
	fields: {
		id: field.string(),
		title: field.string(),
	},
	documents: { body: document.plainText },
});

export const workspaceCandidate = defineWorkspace({
	appId: 'records-version-fixture',
	dataVersion: 1,
	name: 'Records version fixture',
	tables: { notes },
	kv: {
		theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
	},
	blobs: { attachments: 'epicenter.fixture-attachments/1' },
});
