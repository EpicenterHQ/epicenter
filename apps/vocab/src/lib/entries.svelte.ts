/**
 * The learner's saved words, read from and saved to the folder's `entries`
 * table.
 *
 * The list is read when the page opens, after the app's own actions, and
 * when the learner returns to the window; the latest read wins. It offers the
 * files that read as words and names the rest, with why, for repair as text.
 *
 * One word is open at a time, kept by `@epicenter/svelte/open-item` in one
 * edit session: a valid word is a row session over its note and stage, and a
 * file that is not a valid word is a text session over its exact text.
 * Leaving a word waits for its saves, then releases its session and lists
 * again. A save that failed or conflicted keeps the word open until the
 * learner discards it (`open` answers `unsaved`, and the view asks).
 * Returning to the window takes a newer version of the open word when it
 * holds nothing unsaved. Every change is counted from its call
 * (`@epicenter/svelte/admissions`), so closing waits for all of them.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive, so two adds of one text reach the same file.
 */

import { InstantString } from '@epicenter/app/field';
import {
	type FolderFiles,
	hashBytes,
	type SyncChoices,
	wellFormed,
} from '@epicenter/folder';
import { createAdmissions } from '@epicenter/svelte/admissions';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { createOpenItem } from '@epicenter/svelte/open-item';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	type EntryFields,
	readEntry,
	readRows,
	type Stage,
	type UnreadableFile,
	type VocabTables,
} from './data.js';

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

/** What the open word's slot holds once loaded. */
type Item =
	| {
			readonly kind: 'word';
			readonly id: string;
			readonly session: RowSession<EntryFields>;
	  }
	| {
			readonly kind: 'text';
			readonly id: string;
			readonly session: TextSession;
	  }
	| { readonly kind: 'failed'; readonly id: string; readonly message: string };

/** The one open word: what its card, or its repair, shows. */
export type Opened = { readonly kind: 'loading'; readonly id: string } | Item;

type Session = RowSession<EntryFields> | TextSession;

/**
 * How a word is shown: opening always asks for it as a word, and a word whose
 * text is not valid is shown as text, so asking again reads it again.
 */
type Key = { readonly id: string; readonly as: 'word' | 'text' };

const CLOSED = 'This page is closing, so nothing was changed.';
const BUSY =
	'This word is busy with another change. Try again when it finishes.';

/** What the learner is told about a failed change. */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
}): string {
	if (error.name === 'Conflict')
		return 'actualSha256' in error && error.actualSha256 === undefined
			? 'The file is no longer here, so nothing was changed.'
			: 'The file changed elsewhere, so nothing was changed. Check it and try again.';
	return error.message;
}

export function createEntriesState({
	table,
	files,
}: {
	table: VocabTables['entries'];
	files: FolderFiles;
}) {
	let rows = $state.raw<Entry[]>([]);
	let repairs = $state.raw<UnreadableFile[]>([]);
	let loadError = $state<string | null>(null);
	let closed = false;
	const admissions = createAdmissions();
	let listSequence = 0;
	/** Words this page saved while a listing was out, kept over that listing. */
	const received = new Map<string, Entry>();
	/** Every saved entry, newest first. */
	const entries = $derived(
		rows.toSorted(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		),
	);

	const locked = () => closed;

	const slot = createOpenItem<Key, Item, Session>({
		load: ({ id }) => load(id),
		sessionOf: (item) => (item.kind === 'failed' ? undefined : item.session),
		keyOf: (item) => ({
			id: item.id,
			as: item.kind === 'text' ? 'text' : 'word',
		}),
		sameKey: (a, b) => a.id === b.id && a.as === b.as,
		closed: () => closed,
	});

	const opened = (): Opened | undefined => {
		const shown = slot.shown;
		if (shown === undefined) return undefined;
		return shown.status === 'loading'
			? { kind: 'loading', id: shown.key.id }
			: shown.item;
	};

	async function refresh() {
		if (closed) return;
		const sequence = ++listSequence;
		// A listing asked for now holds every word saved before it.
		received.clear();
		const { data: listing, error } = await table.list();
		if (closed || sequence !== listSequence) return;
		if (error !== null) {
			// Keep what was listed; never show an empty list for a failed read.
			loadError = error.message;
			return;
		}
		const read = readRows(table.name, listing, readEntry);
		const listed = new Set(read.rows.map(({ id }) => id));
		rows = [
			...read.rows,
			...[...received.values()].filter(({ id }) => !listed.has(id)),
		];
		repairs = read.unreadable;
		loadError = null;
	}

	/** List one word this page just saved; a listing already out keeps it. */
	function receive(entry: Entry) {
		received.set(entry.id, entry);
		rows = [...rows.filter(({ id }) => id !== entry.id), entry];
	}

	async function load(id: string): Promise<Item> {
		const { data: stored, error } = await table.get(id);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				id,
				session: createTextSession(files, error, { locked }),
			};
		if (error !== null) return { kind: 'failed', id, message: error.message };
		if (stored === undefined)
			return { kind: 'failed', id, message: 'This word’s file is gone.' };
		return {
			kind: 'word',
			id,
			session: createRowSession(table, stored, { locked }),
		};
	}

	/**
	 * Open the word at `id`: as its note and stage when it is a valid word,
	 * else as its exact text. The open word's saves land first and the list is
	 * read again. Answers `unsaved`, opening nothing, when the open word holds
	 * a draft it could not save; opening again with `discard` set to the
	 * answered session lets it go. Opening the word already shown as a word
	 * does nothing; a word shown as text is read again, since its text may be
	 * a valid word now.
	 */
	async function open(id: string, { discard }: { discard?: Session } = {}) {
		const opening = await slot.open({ id, as: 'word' }, { discard });
		if (opening.kind !== 'done') return opening;
		// A word left, or one that is not listed or no longer opens, lists again.
		const item = slot.item;
		if (
			opening.left ||
			item?.kind === 'failed' ||
			!rows.some((entry) => entry.id === id)
		)
			void refresh();
		return opening;
	}

	/** The open word's row session, if `id` is open as a word. */
	const wordSession = (id: string) => {
		const item = slot.item;
		return item?.kind === 'word' && item.id === id ? item.session : undefined;
	};

	async function addWord(
		text: string,
	): Promise<Result<'added' | 'present', EntryError>> {
		const exact = wellFormed(text.trim());
		if (exact === '') return EntryError.Empty();
		// A word under another name, such as one written outside Vocab, is
		// found by its text; each match is read before it is called present.
		for (const listed of rows.filter((entry) => entry.text === exact)) {
			const { data: current } = await table.get(listed.id);
			if (current?.row.fields.text === exact) return Ok('present');
		}
		const stem = await hashBytes(new TextEncoder().encode(exact));
		const { data: created, error } = await table.create(
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
		if (error === null) {
			receive(readEntry(stem, created));
			return Ok('added');
		}
		if (error.name !== 'Exists') return EntryError.NotSaved({ cause: error });
		// Another add, another tab, or an earlier attempt whose answer was
		// lost made the file. It is this word only if it holds this text.
		const { data: current, error: readError } = await table.get(stem);
		if (
			readError !== null &&
			readError.name !== 'InvalidRow' &&
			readError.name !== 'InvalidUtf8'
		)
			return EntryError.NotSaved({ cause: readError });
		if (current?.row.fields.text !== exact)
			return EntryError.Taken({ path: error.path });
		receive(readEntry(stem, current));
		return Ok('present');
	}

	async function setStage(
		entry: Entry,
		stage: Stage,
	): Promise<string | undefined> {
		const item = slot.item;
		if (item?.kind === 'text' && item.id === entry.id)
			return 'This word is open as text, so change its stage there.';
		const session = wordSession(entry.id);
		if (session !== undefined) {
			if (session.locked) return BUSY;
			session.edit((row) => {
				row.fields.stage = stage;
			});
			return undefined;
		}
		// Closed, or still loading: saved as the list showed it.
		const { row } = entry.stored;
		const { error } = await table.replace(entry.stored, {
			fields: { ...row.fields, stage },
			body: row.body,
		});
		await refresh();
		return error === null ? undefined : describeError(error);
	}

	async function resolve(
		session: Session,
		choices: SyncChoices,
	): Promise<string | undefined> {
		const resolved = await slot.resolve(session, choices);
		if (resolved === undefined) return undefined;
		await refresh();
		return resolved.error === null ? undefined : describeError(resolved.error);
	}

	async function remove(entry: Entry): Promise<string | undefined> {
		const item = slot.item;
		const session =
			item !== undefined && item.kind !== 'failed' && item.id === entry.id
				? item.session
				: undefined;
		// The open word: its last saves land, and what they saved is removed.
		const removed =
			session === undefined
				? undefined
				: await slot.removeOpen(session, (file) => table.delete(file));
		const { error } = removed ?? (await table.delete(entry.stored));
		await refresh();
		return error === null ? undefined : describeError(error);
	}

	/** A learner's change: refused once closing, else counted from the call until it settles. */
	function change<TArgs extends unknown[]>(
		work: (...args: TArgs) => Promise<string | undefined>,
	): (...args: TArgs) => Promise<string | undefined> {
		const admitted = admissions.command(work);
		return (...args) => (closed ? Promise.resolve(CLOSED) : admitted(...args));
	}

	return {
		/** Every saved word, newest first, as last listed. */
		get entries() {
			return entries;
		},
		/** Files in `entries/` that are not valid words, with why. */
		get repairs() {
			return repairs;
		},
		/** Why the words could not be listed at all, until a listing succeeds. */
		get loadError() {
			return loadError;
		},
		/** The open word, or `undefined`. */
		get opened() {
			return opened();
		},
		/** Whether leaving now could lose something: the open word holds a save running or failed, or a change is under way. */
		get unsaved() {
			return slot.unsaved || admissions.busy;
		},
		/** Whether the word at `id` refuses input now: a conflict command runs on it, or the page is closing. */
		isLocked(id: string) {
			return closed || (wordSession(id)?.locked ?? false);
		},
		refresh,
		/** Returning to the window: list again, and take a newer version of the open word when it holds nothing unsaved. */
		async check() {
			await Promise.all([refresh(), slot.adopt()]);
		},
		open,
		/** The note and stage shown for `entry`: the open draft's when it is open. */
		fieldsOf(entry: Entry): EntryFields {
			return wordSession(entry.id)?.draft.fields ?? entry.stored.row.fields;
		},
		/**
		 * Save a word or a captured phrase, and answer once the folder holds its
		 * file. The text is trimmed and otherwise exact. `present` means a word
		 * with that exact text is already saved and nothing was written. `note`
		 * starts empty and `stage` new: both are the learner's to set.
		 */
		add: admissions.command(addWord),
		/** Type the open word's note. */
		inputNote(id: string, note: string) {
			wordSession(id)?.edit((row) => {
				row.fields.note = wellFormed(note);
			});
		},
		/**
		 * Press a stage. The open word takes it as an edit to its draft. A word
		 * that is not open, or is still loading, is replaced, guarded by the
		 * version the list read: one that changed since is refused, and the list
		 * reads it again. Answers what the learner is told, if anything.
		 */
		setStage: change(setStage),
		/**
		 * Answer every conflict in `session`'s review at once, the open word's.
		 * The word then shows the result; one deleted elsewhere that stays
		 * deleted closes, and one that is no longer a valid word opens again as
		 * text, or as why it cannot be shown. A refused answer keeps the review
		 * with its problems. Answers what the learner is told, if anything.
		 */
		resolve: change(resolve),
		/**
		 * Delete `entry`. The open word's session is released first and its last
		 * saves land, so the delete removes what this page saved last; a closed
		 * word is deleted only as the list showed it. A file changed elsewhere
		 * since is refused, and an open word then opens again from the file.
		 * Answers what the learner is told, if anything.
		 */
		remove: change(remove),
		/**
		 * Stop before the page releases its folder: changes already under way
		 * finish, the open word's saves land, and it is let go.
		 */
		async close() {
			closed = true;
			await admissions.quiet();
			await slot.close();
		},
	};
}

export type EntriesState = ReturnType<typeof createEntriesState>;
