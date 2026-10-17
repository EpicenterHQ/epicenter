/**
 * The learner's saved words (ADR-0548).
 *
 * The `entries` table's listing is one query under the folder's keys: the
 * files that read as words, and the ones that do not, each with why, for
 * repair as text. It is read on open and again when the folder reports a
 * change to `entries/`. This page's own saves are not reported: each puts
 * what it wrote in the listing itself.
 *
 * A note or a stage is set on the word's file as it is now (ADR-0576): it
 * sets that field and keeps every other field another writer changed. A
 * note typed is the word's field draft (`edits.field`), sent a second after
 * the last keystroke; a stage press sends at once. One word's writes run one
 * at a time, in the order made. A failed write is reported, and the card
 * keeps what was typed.
 *
 * A word file that is not a valid word is repaired as its exact text, read
 * as its own query and written through its text draft (`edits.text`): it
 * holds the text it started from, saves after a pause in typing, one write
 * at a time, as the change from that text, merged with a change made
 * elsewhere (ADR-0576). Where both changed the same lines, the save wins,
 * with no notice. A word file deleted elsewhere takes no repair: the text
 * typed is offered instead. Adding a word is a mutation, and a delete runs
 * once the word's edits landed, so closing waits for both. A delete
 * deletes the file whatever it holds by then (ADR-0576).
 *
 * A new word's file is named by the SHA-256 of its exact text, so two adds
 * of one text reach the same file. An add reads that file first and writes
 * only when none is there.
 */

import { InstantString } from '@epicenter/definition/field';
import {
	hashBytes,
	isStoredRow,
	rowPath,
	type StoredRow,
	type TableListing,
	type WriteError,
	wellFormed,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import type { Edits } from '@epicenter/svelte/edits';
import { ActionError } from '@epicenter/svelte/write-failure';
import type { QueryClient } from '@tanstack/svelte-query';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createQueryFactories } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	type EntryFields,
	readEntry,
	readRows,
	type UnreadableFile,
	type VocabFolder,
} from './data.js';
import { type VocabOptions, vocabKeys } from './query.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	/** Another file is where this text's file belongs. Nothing was written. */
	Taken: ({ path }: { path: string }) => ({
		message: `A different file is already saved at '${path}', so this word was not added.`,
		path,
	}),
	/** The folder did not confirm the save. */
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This word was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

/** Every word file, as the table lists it: a word, or why it is not one. */
export type EntryListing = TableListing<EntryFields>;

/** The directory, and table, that holds the words. */
const ENTRIES = 'entries';

/** Every word that reads as one, newest first. */
export function wordsOf(listing: EntryListing): Entry[] {
	return readRows(ENTRIES, listing, readEntry)
		.rows.slice()
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		);
}

/** The word files that are not words, each with why, by path. */
export function repairsOf(listing: EntryListing): UnreadableFile[] {
	return readRows(ENTRIES, listing, readEntry)
		.unreadable.slice()
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function createEntries(
	folder: Pick<VocabFolder, 'tables'>,
	queries: Pick<VocabOptions, 'entries' | 'files'>,
	queryClient: QueryClient,
	edits: Edits<VocabFolder['tables']>,
) {
	const table = folder.tables.entries;
	const { defineMutation } = createQueryFactories(queryClient);
	const listKey = queries.entries.list.queryKey();
	const textKey = (path: string) => queries.files.text.queryKey(path);
	/** The word file open as text for repair, if one is. */
	let repair = $state<string | undefined>();

	const pathOf = (id: string) => rowPath(table.name, id);
	const listingData = () => queryClient.getQueryData<EntryListing>(listKey);
	/** The text of `path` as the cache holds it, when it opens as text. */
	const shownText = (path: string) => {
		const opened = queryClient.getQueryData<OpenedFile>(textKey(path));
		return opened?.kind === 'text' ? opened.text : undefined;
	};

	const addWord = defineMutation({
		mutationKey: vocabKeys.add,
		mutationFn: async (
			text: string,
		): Promise<
			Result<
				{
					outcome: 'added' | 'present';
					id: string;
					stored: StoredRow<EntryFields>;
				},
				EntryError | ActionError
			>
		> => {
			const why = edits.refusal();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			// Well formed as the folder stores it, so a word read back compares
			// equal to the text it was added with.
			const exact = wellFormed(text.trim());
			if (exact === '') return EntryError.Empty();
			// A word under another name, such as one written outside Vocab, is
			// found by its text; each match is read before it is called present.
			const listing = listingData() ?? [];
			for (const listed of wordsOf(listing).filter(
				(entry) => entry.text === exact,
			)) {
				const { data: current } = await table.get(listed.id);
				if (current?.row.fields.text === exact)
					return Ok({ outcome: 'present', id: listed.id, stored: current });
			}
			const stem = await hashBytes(new TextEncoder().encode(exact));
			const { data: created, error } = await edits.writes.tables.entries.create(
				{
					fields: {
						text: exact,
						note: '',
						stage: 'new',
						createdAt: InstantString.now(),
					},
					body: '',
				},
				{ stem },
			);
			if (error !== null) {
				if (error.name !== 'Occupied')
					return EntryError.NotSaved({ cause: error });
				// A file is already at the stem. Another add, another tab, or an
				// earlier attempt whose answer was lost may have made it: it is
				// this word only if it holds this text.
				const { data: current, error: readError } = await table.get(stem);
				// It was deleted since: nothing holds this word.
				if (readError === null && current === undefined)
					return EntryError.NotSaved({ cause: error });
				if (
					readError !== null &&
					readError.name !== 'InvalidRow' &&
					readError.name !== 'InvalidUtf8'
				)
					return EntryError.NotSaved({ cause: readError });
				if (current?.row.fields.text === exact)
					return Ok({ outcome: 'present', id: stem, stored: current });
				return EntryError.Taken({ path: pathOf(stem) });
			}
			// Only a row this create wrote can stand at a stem it found vacant.
			if (!isStoredRow(created))
				return EntryError.Taken({ path: pathOf(stem) });
			return Ok({ outcome: 'added', id: stem, stored: created });
		},
		// A word found already saved may be one the listing does not hold yet.
		onSuccess: ({ outcome }) =>
			outcome === 'present'
				? queryClient.invalidateQueries({ queryKey: listKey, exact: true })
				: undefined,
	});

	/** Whether the word at `id` takes an edit now: not closing, deleted, or open as text. */
	function canEdit(id: string) {
		const path = pathOf(id);
		return repair !== path && !edits.locked(path);
	}

	return {
		/** The word listing, narrowed by `select` for one view. */
		entriesQuery<TData = EntryListing>(
			select?: (listing: EntryListing) => TData,
		) {
			return { ...queries.entries.list.queryOptions(), select };
		},
		/** One word file's exact text, or its type and size when it is not editable text. */
		textQuery: (path: string) => queries.files.text.queryOptions(path),
		/** The note typed into the word at `id` and not yet saved: its field draft. */
		noteOf: (id: string) => edits.field('entries', id, 'note'),
		canEdit,
		/** Whether the word at `id` takes no edit now: closing, being deleted, or open as text. */
		isLocked: (id: string) => !canEdit(id),

		/**
		 * Save a word or a captured phrase, and answer once the folder holds its
		 * file. The text is trimmed and otherwise exact. `present` means a word
		 * with that exact text is already saved and nothing was written. `note`
		 * starts empty and `stage` new: both are the learner's to set.
		 */
		async add(
			text: string,
		): Promise<Result<'added' | 'present', EntryError | ActionError>> {
			const { data, error } = await addWord(text);
			return error === null ? Ok(data.outcome) : Err(error);
		},
		/** Send the note of the word at `id` now; answers whether it was sent. */
		setNote(id: string, note: string): boolean {
			if (!canEdit(id)) return false;
			const draft = edits.field('entries', id, 'note');
			if (!draft.change(note)) return false;
			void draft.save();
			return true;
		},
		/** Press a stage of the word at `id`; it is sent at once. Answers whether it was. */
		setStage(id: string, stage: EntryFields['stage']): boolean {
			if (!canEdit(id)) return false;
			return edits.set('entries', id, { stage }) === undefined;
		},
		/**
		 * Delete `entry` once the word's edits landed, the repair text typed
		 * included, whatever the file holds then.
		 */
		async delete(
			entry: Entry,
		): Promise<Result<undefined, WriteError | ActionError>> {
			const why = edits.refusal();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			const path = pathOf(entry.id);
			const deleted = await edits.exclusive(path, () =>
				edits.writes.tables.entries.delete(entry.id),
			);
			if (deleted.error !== null) return deleted;
			queryClient.removeQueries({ queryKey: textKey(path), exact: true });
			if (repair === path) repair = undefined;
			return deleted;
		},

		/** The word file open as text for repair, if one is. */
		get repairing() {
			return repair;
		},
		/** The text typed for the repair and not yet written, if any; read reactively. */
		get repairText() {
			return repair === undefined ? undefined : edits.text(repair).typed;
		},
		/** Open a word file as its exact text. */
		openRepair(path: string) {
			repair = path;
		},
		/**
		 * Close the repair once its text is written; the write marked the
		 * word stale, so a repaired file shows as a word. Answers whether it
		 * closed: a text that could not be written keeps the repair open.
		 */
		async closeRepair(): Promise<boolean> {
			const open = repair;
			if (open === undefined) return true;
			const draft = edits.text(open);
			await draft.save();
			if (draft.typed !== undefined) return false;
			if (repair === open) repair = undefined;
			queryClient.removeQueries({ queryKey: textKey(open), exact: true });
			return true;
		},
		/** Type the text of the word file open for repair; it is written after a pause, or at `saveRepair`. */
		inputText(path: string, text: string) {
			if (repair !== path) return false;
			const draft = edits.text(path);
			if (draft.typed === undefined && shownText(path) === undefined)
				return false;
			return draft.change(text);
		},
		/** Write the repair text typed, if any; resolves once no write of it runs. */
		saveRepair: () =>
			repair === undefined ? Promise.resolve() : edits.text(repair).save(),
	};
}

export type Entries = ReturnType<typeof createEntries>;
