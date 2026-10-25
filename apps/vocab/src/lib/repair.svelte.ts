import { readRow } from '@epicenter/folder/next';
import { type VocabFolder, vocabTables } from './data.js';

/** Which word file is open as text. The editor owns its draft. */
export function createRepair(folder: VocabFolder) {
	let open = $state<string | undefined>();
	return {
		get open() {
			return open;
		},
		start(id: string) {
			open = id;
		},
		close(text: string): boolean {
			const id = open;
			if (id === undefined) return false;
			if (readRow(text, vocabTables.entries).issues !== null) return false;
			const row = folder.tables.entries.row(id);
			if (row === undefined || row.issues !== null) return false;
			open = undefined;
			return true;
		},
	};
}

export type Repair = ReturnType<typeof createRepair>;
