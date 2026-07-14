import {
	defineKv,
	defineTable,
	defineWorkspace,
	document,
	field,
} from '@epicenter/workspace/sqlite';

const notes = defineTable({
	fields: {
		id: field.id(),
		title: field.string(),
		body: field.doc(document.plainText),
	},
});

export const workspaceCandidate = defineWorkspace({
	appId: 'records-version-fixture',
	version: 1,
	name: 'Records version fixture',
	tables: { notes },
	kv: {
		theme: defineKv(field.select(['light', 'dark']), () => 'light' as const),
	},
});
