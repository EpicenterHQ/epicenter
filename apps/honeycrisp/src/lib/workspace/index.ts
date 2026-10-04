/**
 * Honeycrisp's inert Data definitions.
 *
 * Runtimes own storage, synchronization, and document lifecycles. This module
 * owns only structured addresses, release-local row lenses, and the one
 * multi-row folder deletion operation shared by the UI and desktop host.
 */

import {
	type BoundData,
	defineTable,
	optional,
	type RowFor,
} from '@epicenter/data';
import { field } from '@epicenter/field';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

export const foldersTable = defineTable({
	namespace: 'so.epicenter.honeycrisp',
	table: 'folders',
	fields: {
		name: field.string(),
		icon: optional(field.string()),
		sortOrder: field.number(),
	},
});
export type Folder = RowFor<typeof foldersTable>;

export const notesTable = defineTable({
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
export type Note = RowFor<typeof notesTable>;

/** Honeycrisp's inert definitions for this release. */
export const honeycrispDefinitions = {
	tables: { folders: foldersTable, notes: notesTable },
	values: {},
} as const;

export type HoneycrispData = BoundData<
	typeof honeycrispDefinitions.tables,
	typeof honeycrispDefinitions.values
>;

/**
 * Delete a folder after best-effort re-parenting of its current notes.
 *
 * The row runtime has no workspace action layer or cross-row transaction. A
 * failed note update stops before the folder is deleted, so the operation can
 * be retried without knowingly leaving a dangling folder id.
 */
export async function deleteHoneycrispFolder(
	data: HoneycrispData,
	folderId: FolderId,
): Promise<void> {
	let cursor: string | undefined;
	do {
		const page = await data.tables.notes.list({ cursor, limit: 100 });
		for (const note of page.rows) {
			if (note.folderId !== folderId) continue;
			const result = await data.tables.notes.update(note.id, {
				folderId: undefined,
			});
			if (result.error !== null) throw result.error;
		}
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	await data.tables.folders.delete(folderId);
}
