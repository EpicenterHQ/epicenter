import type { Saved } from '@epicenter/folder/next';
import { readRow } from '@epicenter/folder/next';
import { type VocabFolder, vocabTables } from './data.js';

/** Which word file is open as text. The editor owns its draft and last save. */
export function createRepair(folder: VocabFolder) {
	let open = $state<string | undefined>();
	return {
		get open() {
			return open;
		},
		start(id: string) {
			open = id;
		},
		async close(text: string, lastSave: Saved | undefined): Promise<boolean> {
			const id = open;
			if (id === undefined) return false;
			if (readRow(text, vocabTables.entries).issues !== null) return false;
			folder.checkpoint();
			if (lastSave && (await lastSave).error !== null) return false;
			const row = folder.tables.entries.row(id);
			if (row?.issues !== null) return false;
			if (open === id) open = undefined;
			return true;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
