import {
	type BoundData,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

export const conversationsTable = defineTable({
	namespace: 'so.epicenter.home',
	table: 'conversations',
	fields: {
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
	},
});

export const honeycrispFoldersTable = defineTable({
	namespace: 'so.epicenter.honeycrisp',
	table: 'folders',
	fields: {
		name: field.string(),
		icon: optional(field.string()),
		sortOrder: field.number(),
	},
});

export const honeycrispNotesTable = defineTable({
	namespace: 'so.epicenter.honeycrisp',
	table: 'notes',
	fields: {
		folderId: optional(field.string()),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: optional(field.instant()),
		wordCount: optional(field.number()),
	},
});

export const homeDefinitions = {
	tables: {
		conversations: conversationsTable,
		folders: honeycrispFoldersTable,
		notes: honeycrispNotesTable,
	},
	values: {},
} as const;

export type Conversation = RowFor<typeof conversationsTable>;
export type HomeData = BoundData<
	typeof homeDefinitions.tables,
	typeof homeDefinitions.values
>;
export type ConversationsData = Pick<HomeData['tables'], 'conversations'>;
export type HoneycrispData = Pick<HomeData['tables'], 'folders' | 'notes'>;
