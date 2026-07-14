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
		archived: field.boolean(),
	},
	documents: { body: document.plainText },
});

export const workspaceCandidate = defineWorkspace({
	appId: 'records-version-fixture',
	dataVersion: 2,
	name: 'Records version fixture',
	tables: { notes },
	kv: {
		theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
	},
	blobs: { attachments: 'epicenter.fixture-attachments/1' },
});
