/**
 * The learner's words, over the one list of `entries/{id}.md` notes: the
 * words that read, newest first; the notes that do not, to repair as text;
 * and adding, editing, and deleting a word.
 */
import type { NoteList } from '@epicenter/svelte/client';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
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
	NotSaved: ({ cause }: { cause: unknown }) => ({
		message: `This word was not saved: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

export type EntryList = NoteList<Vocab['collections']['entries']>;

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

/** The words that read, newest first, each `waiting` (not uploaded yet) as `waiting` says. */
export function wordsOf(
	notes: readonly EntryNote[],
	waiting: (id: string) => boolean = () => false,
): Entry[] {
	return notes
		.map((note) => ({ ...readEntry(note), waiting: waiting(note.id) }))
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		);
}

export function createEntries(
	list: EntryList,
	{ uploads }: { uploads: boolean } = { uploads: false },
) {
	return {
		/** The one list itself, for editors (`fieldEdit`) and repair (`NoteRepair`). */
		list,
		get words() {
			// Signed in, a word whose copy is still on this device has not uploaded yet.
			return wordsOf(
				list.items,
				(id) => uploads && list.where?.({ id }) === 'device',
			);
		},
		get repairs(): EntryRepair[] {
			return list.invalid
				.map(({ id, path, issues, text }) => ({
					id,
					path,
					reason: reasonOf(issues),
					text,
				}))
				.sort((a, b) => a.path.localeCompare(b.path));
		},
		/**
		 * Trim and normalize an expression, then save it under its SHA-256 id.
		 * Exact text already listed answers `present`; a different file at that
		 * id answers `Taken`. Lone surrogates become U+FFFD.
		 */
		async add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			const exact = text.trim().toWellFormed();
			if (exact === '') return EntryError.Empty();
			if (list.items.some((note) => note.text === exact)) return Ok('present');
			const id = await wordId(exact);
			/** What is at `id` already: this word, another file, or nothing. */
			const judge = () => {
				const word = list.get({ id });
				if (word !== undefined)
					return word.text === exact
						? Ok('present' as const)
						: EntryError.Taken({ path: entryPath(id) });
				return list.invalid.some((note) => note.id === id)
					? EntryError.Taken({ path: entryPath(id) })
					: null;
			};
			const before = judge();
			if (before) return before;
			const { error } = await list.create({
				id,
				text: exact,
				stage: 'new',
				createdAt: new Date().toISOString(),
				body: '',
			});
			if (error?.name === 'Occupied')
				return judge() ?? EntryError.Taken({ path: entryPath(id) });
			return error ? EntryError.NotSaved({ cause: error }) : Ok('added');
		},
		/** Set only the learner's stage, over the word as shown. */
		setStage(id: string, stage: Stage) {
			return list.update({ id }, { stage });
		},
		delete(id: string) {
			return list.delete({ id });
		},
		repair: createRepair(),
	};
}

export type Entries = ReturnType<typeof createEntries>;
