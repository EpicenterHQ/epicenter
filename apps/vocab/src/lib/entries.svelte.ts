/**
 * The learner's words, over the folder's `entries/{id}.md` notes: the
 * words that read, newest first; the notes that do not, to repair as text;
 * and adding, editing, and deleting a word.
 */
import type { FolderNotes } from '@epicenter/folder/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Vocab } from './contract.js';
import {
	type Entry,
	type EntryNote,
	readEntry,
	reasonOf,
	type Stage,
} from './data.js';
import { createRepair } from './repair.svelte.js';

export const EntryError = defineErrors({
	Empty: () => ({ message: 'There is no text to save.' }),
	Taken: ({ path }: { path: string }) => ({
		message: `A different file is already saved at '${path}', so this word was not added.`,
		path,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

/** The word notes, as the folder shows them (`folder.entries` from `$lib/app.js`, read through `reactive`). */
export type EntryList = FolderNotes<Vocab['collections']['entries']>;

/** A word note that does not read, as the repair list shows it. */
export type EntryRepair = {
	id: string;
	path: string;
	reason: string;
	/** Null when the file is not text: it is named, never repaired here. */
	text: string | null;
};

const entryPath = (id: string) => `entries/${id}.md`;

async function wordId(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** The words that read, newest first. */
export function wordsOf(notes: readonly EntryNote[]): Entry[] {
	return notes
		.map(readEntry)
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		);
}

export function createEntries(list: EntryList) {
	/** The add before this one: adds run one at a time, so each finds the word the last one saved. */
	let adding: Promise<unknown> = Promise.resolve();

	async function addNow(
		text: string,
	): Promise<Result<'added' | 'present', EntryError>> {
		const exact = text.trim().toWellFormed();
		if (exact === '') return EntryError.Empty();
		if (list.items().some((note) => note.text === exact))
			return Ok('present');
		const id = await wordId(exact);
		// No listed word has this text, so a note at its path is another word or one that does not read.
		if (
			list.get({ id }) !== undefined ||
			list.invalid().some((note) => note.id === id)
		)
			return EntryError.Taken({ path: entryPath(id) });
		await list.set(
			{ id },
			{ text: exact, stage: 'new', createdAt: new Date().toISOString() },
		);
		return Ok('added');
	}

	return {
		/**
		 * The word notes themselves: a card edits its word's note through them
		 * (`notes.edit`), and a repair edits the text of one that does not read.
		 */
		notes: list,
		get words() {
			return wordsOf(list.items());
		},
		get repairs(): EntryRepair[] {
			return list
				.invalid()
				.map(({ id, path, issues, text }) => ({
					id,
					path,
					reason: reasonOf(issues),
					text,
				}))
				.sort((a, b) => a.path.localeCompare(b.path));
		},
		/**
		 * Trim and normalize an expression, then save it under its SHA-256 id,
		 * answering once it has landed. Lone surrogates become U+FFFD. A word
		 * is added only after the words were listed and `get` shows none with
		 * its text: one there answers `present`, and a different note at its
		 * path (another word, or one that does not read) answers `Taken`. The
		 * same word added on two computers before they sync is one word, with
		 * the later add's stage (ADR-0774).
		 */
		add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			const added = adding.then(() => addNow(text));
			adding = added;
			return added;
		},
		/** Set only the learner's stage, on a word the folder shows: a word deleted elsewhere is not made again. */
		async setStage(id: string, stage: Stage) {
			if (list.get({ id }) === undefined) return;
			await list.set({ id }, { stage });
		},
		delete(id: string) {
			return list.delete({ id });
		},
		repair: createRepair(),
	};
}

export type Entries = ReturnType<typeof createEntries>;
