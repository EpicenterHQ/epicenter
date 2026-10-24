/**
 * The learner's saved words.
 *
 * The `entries` table's rows are one query of the local folder context: the
 * files that read as words, and the ones that do not, each with why, for
 * repair as text. It is read on open and again whenever the folder reports a
 * committed save under `entries/`, from this page or another tab.
 *
 * A note or a stage is typed through the word's edit handle
 * (`folder.tables.entries.document(id)`): a note typed is saved a second after
 * the last keystroke, a stage press at once. The folder holds every field
 * typed since the word last saved, so one word's saves run one at a time
 * and a stage press never undoes a note. Fields and body share one exact
 * source. Writes publish the whole current source; outside writers may
 * overwrite it, and later local publications may overwrite them. A failed save keeps the
 * typing and its error.
 *
 * A new word's file is named by the SHA-256 of its exact text, so two adds
 * of one text reach the same file. An add reads that file first and writes
 * only when none is there.
 */

import { ActionError, type SaveFailure } from '@epicenter/folder/document';
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
} from './data.js';
import { untilClosed } from './failure.js';
import { createRepair } from './repair.svelte.js';
import type { VocabContext } from './vocab.svelte.js';

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
export type EntryRows = RowOf<'entries'>[];

/** The file name shared by every add of the same exact word text. */
async function wordId(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Every word that reads as one, newest first. */
export function wordsOf(rows: EntryRows): Entry[] {
	return readRows('entries', rows, readEntry).rows.sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
}

/** The word files that are not words, each with why, by path. */
export function repairsOf(rows: EntryRows): UnreadableFile[] {
	return readRows('entries', rows, readEntry).unreadable.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

export function createEntries(local: VocabContext) {
	const { folder, queries, queryClient, refresh } = local;
	const rowsKey = queries.rows('entries').queryKey;
	const repair = createRepair(folder);
	const cachedRows = () => queryClient.getQueryData<EntryRows>(rowsKey) ?? [];
	/** Read the words again, and answer once the list holds the read. */
	const reread = () => refresh(['entries']);

	async function addWord(
		exact: string,
	): Promise<Result<'added' | 'present', EntryError>> {
		// A word under another name, such as one written outside Vocab, is
		// found by its text; each match is read before it is called present.
		for (const listed of wordsOf(cachedRows()).filter(
			(entry) => entry.text === exact,
		)) {
			const { data: current } = await folder.tables.entries.get(listed.id);
			if (current?.issues === null && current.fields.text === exact) {
				await reread();
				return Ok('present');
			}
		}
		const id = await wordId(exact);
		const { data: current, error: readError } =
			await folder.tables.entries.get(id);
		if (readError !== null) return EntryError.NotSaved({ cause: readError });
		// Another add, another tab, or an earlier attempt whose answer was
		// lost may have made it: it is this word only if it holds this text.
		if (current !== undefined) {
			if (current.issues !== null || current.fields.text !== exact)
				return EntryError.Taken({ path: rowPath('entries', id) });
			await reread();
			return Ok('present');
		}
		const { error } = await folder.tables.entries.write(id, {
			fields: {
				text: exact,
				note: '',
				stage: 'new',
				createdAt: new Date().toISOString(),
			},
			body: '',
		});
		if (error !== null) return EntryError.NotSaved({ cause: error });
		// Listed before the add answers, so the word is there when it does.
		await reread();
		return Ok('added');
	}

	/** The folder's working document of the word at `id`, observed by its caller. */
	function document(id: string) {
		return folder.tables.entries.document(id);
	}

	return {
		/** Interpret editable source as an entry without reading storage. */
		parse: folder.tables.entries.parse,
		/** The word rows, narrowed by `select` for one view. */
		entriesQuery<TData = EntryRows>(select?: (rows: EntryRows) => TData) {
			return { ...queries.rows('entries'), select };
		},
		/**
		 * The word at `id` as views show and type into it: the folder's edit of
		 * its row, acquired and observed by its mounted subscription.
		 */
		document,

		/**
		 * Save a word or a captured phrase, and answer once the list holds it.
		 * The text is trimmed and otherwise exact, but for half of a surrogate
		 * pair, which is saved as U+FFFD. `present` means a word with that
		 * exact text is already saved and nothing was written. `note` starts
		 * empty and `stage` new: both are the learner's to set.
		 */
		async add(
			text: string,
		): Promise<Result<'added' | 'present', EntryError | ActionError>> {
			if (local.closing) return ActionError.Closing();
			const exact = text.trim().toWellFormed();
			if (exact === '') return EntryError.Empty();
			return untilClosed(
				() => addWord(exact),
				(cause) => EntryError.NotSaved({ cause }),
			);
		},
		/**
		 * Type the note of `entry`; it is saved a second after the last change.
		 * Half of a surrogate pair is kept as U+FFFD, which the folder can
		 * save. Answers the edit's acceptance result, including its refusal.
		 */
		setNote: (entry: Entry, note: string) =>
			folder.tables.entries.document(entry.id).patch({
				fields: { note: note.toWellFormed() },
			}),
		/** Press a stage of `entry`; it is saved at once. Answers the edit's acceptance result. */
		setStage(entry: Entry, stage: Stage) {
			const edit = folder.tables.entries.document(entry.id);
			const changed = edit.patch({ fields: { stage } });
			if (changed.error !== null) return changed;
			void edit.save();
			return changed;
		},
		/** Delete the path without publishing an unsubmitted draft first. */
		delete(entry: Entry) {
			return folder.files.delete(rowPath('entries', entry.id));
		},

		/** Failed word publications, without acquiring their editors. */
		get failures(): SaveFailure[] {
			return local
				.getStatus()
				.failures.filter((pending) =>
					/^entries\/[^/]+\.md$/.test(pending.path),
				);
		},

		/** The repair of a word file as its exact text. */
		repair,
	};
}

export type Entries = ReturnType<typeof createEntries>;
