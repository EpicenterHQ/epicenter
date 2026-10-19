/**
 * The learner's saved words.
 *
 * The `entries` table's rows are one query of the local folder context: the
 * files that read as words, and the ones that do not, each with why, for
 * repair as text. It is read on open and again whenever the folder reports a
 * committed save under `entries/`, from this page or another tab.
 *
 * A note or a stage is the word's row draft (`edits.row`): a note typed is
 * saved a second after the last keystroke, a stage press at once. A draft
 * holds every field typed since the word last saved, so one word's saves run
 * one at a time and a stage press never undoes a note. Each save names the
 * row it started from, and the folder merges it with whatever was saved
 * meanwhile: what only the other writer changed stays, and this edit wins
 * the field both changed. A failed save keeps the typing and its error.
 *
 * A new word's file is named by the SHA-256 of its exact text, so two adds
 * of one text reach the same file. An add reads that file first and writes
 * only when none is there.
 */

import type { ReadError, SaveError } from '@epicenter/folder';
import type { Unsaved } from '@epicenter/svelte/edits';
import { ActionError } from '@epicenter/svelte/write-failure';
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
import { CLOSING, untilClosed } from './failure.js';
import { createRepair } from './repair.svelte.js';
import type { Actions, VocabContext } from './vocab.svelte.js';

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
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Every word that reads as one, newest first. */
export function wordsOf(rows: EntryRows): Entry[] {
	return readRows('entries', rows, readEntry).rows.sort(
		(a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
	);
}

/** The word files that are not words, each with why, by path. */
export function repairsOf(rows: EntryRows): UnreadableFile[] {
	return readRows('entries', rows, readEntry).unreadable.sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
}

export function createEntries(
	{ folder, queries, queryClient, edits }: VocabContext,
	actions: Actions,
) {
	const table = folder.tables.entries;
	const rowsKey = queries.rows('entries').queryKey;
	const repair = createRepair(folder, { fenced: () => edits.fenced });
	const cachedRows = () => queryClient.getQueryData<EntryRows>(rowsKey) ?? [];
	/** Read the words again, and answer once the list holds the read. */
	const reread = () => queryClient.invalidateQueries({ queryKey: rowsKey });

	/** Whether the word at `id` takes an edit now: not closing, deleted, or open as text. */
	function canEdit(id: string) {
		return repair.open !== id && !edits.row('entries', id).locked;
	}

	async function addWord(
		exact: string,
	): Promise<Result<'added' | 'present', EntryError>> {
		// A word under another name, such as one written outside Vocab, is
		// found by its text; each match is read before it is called present.
		for (const listed of wordsOf(cachedRows()).filter(
			(entry) => entry.text === exact,
		)) {
			const { data: current } = await table.get(listed.id);
			if (current?.issues === null && current.fields.text === exact) {
				await reread();
				return Ok('present');
			}
		}
		const id = await wordId(exact);
		const { data: current, error: readError } = await table.get(id);
		if (readError !== null) return EntryError.NotSaved({ cause: readError });
		// Another add, another tab, or an earlier attempt whose answer was
		// lost may have made it: it is this word only if it holds this text.
		if (current !== undefined) {
			if (current.issues !== null || current.fields.text !== exact)
				return EntryError.Taken({ path: rowPath('entries', id) });
			await reread();
			return Ok('present');
		}
		const { error } = await table.set(id, null, {
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

	return {
		/** The word rows, narrowed by `select` for one view. */
		entriesQuery<TData = EntryRows>(select?: (rows: EntryRows) => TData) {
			return { ...queries.rows('entries'), select };
		},
		/** The typing held for the word at `id`: its row draft. */
		draftOf: (id: string) => edits.row('entries', id),
		canEdit,
		/** Whether the word at `id` takes no edit now: closing, being deleted, or open as text. */
		isLocked: (id: string) => !canEdit(id),

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
			if (edits.fenced) return ActionError.NotStarted({ reason: CLOSING });
			const exact = text.trim().toWellFormed();
			if (exact === '') return EntryError.Empty();
			return actions.track(() =>
				untilClosed(
					() => addWord(exact),
					(cause) => EntryError.NotSaved({ cause }),
				),
			);
		},
		/**
		 * Type the note of `entry`; it is saved a second after the last change.
		 * Half of a surrogate pair is kept as U+FFFD, which the folder can
		 * save. Answers whether it was taken.
		 */
		setNote(entry: Entry, note: string): boolean {
			if (!canEdit(entry.id)) return false;
			return edits
				.row('entries', entry.id)
				.change(entry.row, { fields: { note: note.toWellFormed() } });
		},
		/** Press a stage of `entry`; it is saved at once. Answers whether it was taken. */
		setStage(entry: Entry, stage: Stage): boolean {
			if (!canEdit(entry.id)) return false;
			const draft = edits.row('entries', entry.id);
			if (!draft.change(entry.row, { fields: { stage } })) return false;
			void draft.save();
			return true;
		},
		/**
		 * Delete `entry` once what is typed into it saved. `deleted` says
		 * whether the word is gone, whoever removed it. A word changed in that
		 * moment, here or in another tab, is kept: `deleted` is false.
		 */
		async delete(
			entry: Entry,
		): Promise<Result<{ deleted: boolean }, SaveError | ReadError | ActionError>> {
			const removed = await edits.delete('entries', entry.id);
			if (removed.error !== null || removed.data.deleted) return removed;
			const { data: current, error } = await untilClosed(
				() => table.get(entry.id),
				() => Ok(entry.row),
			);
			return Ok({ deleted: error === null && current === undefined });
		},

		/** The words whose last save failed, with what was typed; read reactively. */
		get failures(): Unsaved[] {
			return edits.failures.filter((draft) => draft.table === 'entries');
		},

		/** The repair of a word file as its exact text. */
		repair,
	};
}

export type Entries = ReturnType<typeof createEntries>;
