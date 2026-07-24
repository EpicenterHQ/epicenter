/**
 * Honeycrisp's inert Lens.
 *
 * Runtimes own storage, synchronization, and document lifecycles. This module
 * owns only the namespace interpretation, release-local row types, and the one
 * multi-row folder deletion operation shared by the UI and desktop host.
 */

import {
	type BoundLens,
	defineLens,
	defineTable,
	type RowFor,
} from '@epicenter/data/runtime';
import { field } from '@epicenter/field';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

export const foldersTable = defineTable({
	title: 'Folders',
	fields: {
		name: field.string(),
		icon: field.string(),
		sortOrder: field.number(),
	},
	optional: ['icon'],
});
export type Folder = RowFor<typeof foldersTable>;

export const notesTable = defineTable({
	title: 'Notes',
	fields: {
		folderId: field.string(),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: field.instant(),
		wordCount: field.number(),
	},
	optional: ['folderId', 'deletedAt', 'wordCount'],
});
export type Note = RowFor<typeof notesTable>;

/** Honeycrisp's release-local interpretation of its one durable namespace. */
export const honeycrispLens = defineLens({
	namespace: 'so.epicenter.honeycrisp',
	title: 'Honeycrisp',
	description: 'Notes and folders.',
	collections: {
		folders: foldersTable,
		notes: notesTable,
	},
});

export type HoneycrispData = BoundLens<typeof honeycrispLens>;

/**
 * Delete a folder after best-effort re-parenting of its current notes.
 *
 * The record runtime has no cross-record transaction. A failed note update
 * stops before the folder is deleted, so the operation can be retried without
 * knowingly leaving a dangling folder id.
 */
export async function deleteHoneycrispFolder(
	data: HoneycrispData,
	folderId: FolderId,
): Promise<void> {
	for await (const entry of data.notes.entries()) {
		if (entry.error !== null) continue;
		const note = entry.data;
		if (note.folderId !== folderId) continue;
		const result = await data.notes.record(note.id).update({
			folderId: undefined,
		});
		if (result.error !== null) throw result.error;
	}
	await data.folders.record(folderId).delete();
}
