/**
 * Legacy synchronous Honeycrisp workspace used only by the unmigrated
 * Epicenter desktop host. New app code uses the versioned SQLite package root.
 */

import { field } from '@epicenter/field';
import {
	attachRichText,
	defineActions,
	defineMutation,
	defineTable,
	defineWorkspace,
	nullable,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import { asFolderId, type FolderId, type NoteId } from './index.js';

const foldersTable = defineTable({
	id: field.string<FolderId>(),
	name: field.string(),
	icon: nullable(field.string()),
	sortOrder: field.number(),
});

const notesTable = defineTable({
	id: field.string<NoteId>(),
	folderId: nullable(field.string<FolderId>()),
	title: field.string(),
	preview: field.string(),
	pinned: field.boolean(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
	deletedAt: nullable(field.instant()),
	wordCount: nullable(field.number()),
}).docs({
	body: {
		layout: attachRichText,
		touch: 'updatedAt',
	},
});

export const honeycrispWorkspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	name: 'honeycrisp',
	tables: { folders: foldersTable, notes: notesTable },
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			folders_delete: defineMutation({
				description: 'Delete a folder and re-parent its notes to unfiled',
				input: Type.Object({ folderId: Type.String() }),
				handler: ({ folderId: rawId }) => {
					const folderId = asFolderId(rawId);
					const folderNotes = tables.notes
						.scan()
						.rows.filter((note) => note.folderId === folderId);
					for (const note of folderNotes) {
						tables.notes.update(note.id, { folderId: null });
					}
					tables.folders.delete(folderId);
				},
			}),
		}),
});
