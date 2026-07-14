import type { AsyncWorkspace } from '@epicenter/workspace/sqlite';
import type { FolderId, foldersTable, notesTable } from './index.js';

type HoneycrispWorkspace = AsyncWorkspace<{
	folders: typeof foldersTable;
	notes: typeof notesTable;
}>;

/** Compose Honeycrisp behavior over the opened async workspace. */
export function createHoneycrispActions(workspace: HoneycrispWorkspace) {
	return {
		async folders_delete({ folderId }: { folderId: FolderId }) {
			const folderNotes = await workspace.tables.notes.list({
				where: { folderId },
			});
			await workspace.transact((batch) => {
				for (const note of folderNotes) {
					batch.tables.notes.patch(note.id, { folderId: null });
				}
				batch.tables.folders.remove(folderId);
			});
		},
	};
}
