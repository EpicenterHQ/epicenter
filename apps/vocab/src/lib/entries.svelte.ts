import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	type RowOf,
	readEntry,
	readRows,
	rowPath,
	type Stage,
	type UnreadableFile,
	type VocabFolder,
} from './data.js';
import { createRepair } from './repair.svelte.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	Taken: ({ path }: { path: string }) => ({
		message: `A different file is already saved at '${path}', so this word was not added.`,
		path,
	}),
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This word was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;
export type EntryRows = readonly RowOf<'entries'>[];

async function wordId(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Read valid words newest first, leaving invalid files to the repair list. */
export function wordsOf(rows: EntryRows): Entry[] {
	return readRows('entries', rows, readEntry).rows.sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
}

export function repairsOf(rows: EntryRows): UnreadableFile[] {
	return readRows('entries', rows, readEntry).unreadable.sort((a, b) =>
		a.path.localeCompare(b.path),
	);
}

export function createEntries(folder: VocabFolder) {
	const table = folder.tables.entries;
	return {
		get words() {
			return wordsOf(table.rows);
		},
		get repairs() {
			return repairsOf(table.rows);
		},
		/**
		 * Trim and normalize an expression, then save it under its SHA-256 ID.
		 * Exact text already listed answers `present`; a different file at that
		 * ID answers `Taken`. Lone surrogates become U+FFFD.
		 */
		async add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			const exact = text.trim().toWellFormed();
			if (exact === '') return EntryError.Empty();
			if (wordsOf(table.rows).some((entry) => entry.text === exact))
				return Ok('present');
			const id = await wordId(exact);
			const same = (row: RowOf<'entries'> | undefined) =>
				row?.issues === null && row.fields.text === exact;
			const current = table.row(id);
			if (current)
				return same(current)
					? Ok('present')
					: EntryError.Taken({ path: current.path });
			const { error } = await table.create(id, {
				fields: {
					text: exact,
					note: '',
					stage: 'new',
					createdAt: new Date().toISOString(),
				},
				body: '',
			});
			if (error?.name === 'Exists') {
				const now = table.row(id);
				return same(now)
					? Ok('present')
					: EntryError.Taken({ path: rowPath('entries', id) });
			}
			return error ? EntryError.NotSaved({ cause: error }) : Ok('added');
		},
		/** Set only the note field over the file's current contents. */
		setNote(id: string, note: string) {
			return table.update(id, { fields: { note } });
		},
		/** Set only the learner's stage over the file's current contents. */
		setStage(id: string, stage: Stage) {
			return table.update(id, { fields: { stage } });
		},
		delete(id: string) {
			return folder.delete(rowPath('entries', id));
		},
		repair: createRepair(folder),
	};
}

export type Entries = ReturnType<typeof createEntries>;
