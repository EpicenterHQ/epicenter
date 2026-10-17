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
 * sets that field and keeps every other field another writer changed. The
 * card holds a note typed and not yet sent; a stage press sends at once.
 * One word's writes run one at a time, in the order made. A failed write is
 * reported, and the card keeps what was typed.
 *
 * A word file that is not a valid word is repaired as its exact text, read
 * as its own query and written the same way: a text editor holding the text
 * it started from, saved after a pause in typing, one write at a time, as the
 * change from that text, merged with a change made elsewhere (ADR-0576).
 * Where both changed the same lines, the save wins, with no notice. A word
 * file deleted elsewhere takes no repair: the text typed is offered instead.
 * Adding and deleting a word are mutations too, so closing waits for them. A
 * delete deletes the file whatever it holds by then (ADR-0576).
 *
 * A new word's file is named by the SHA-256 of its exact text, so two adds
 * of one text reach the same file. An add reads that file first and writes
 * only when none is there.
 */

import { InstantString } from '@epicenter/definition/field';
import {
	FileError,
	hashBytes,
	isStoredRow,
	rowPath,
	type StoredRow,
	type TableListing,
	type WriteError,
	wellFormed,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import { runMutation, whenIdle } from '@epicenter/folder/query';
import {
	createTextEditor,
	type TextChange,
	type TextEditor,
} from '@epicenter/folder/svelte';
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber } from 'svelte/reactivity';
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
import { type VocabOptions, vocabKeys, type WriteFailure } from './query.js';

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
	/** The page is closing, so the change did not start. */
	NotStarted: ({ reason }: { reason: string }) => ({
		message: reason,
		reason,
	}),
});
export type EntryError = InferErrors<typeof EntryError>;

/** Every word file, as the table lists it: a word, or why it is not one. */
export type EntryListing = TableListing<EntryFields>;

/** The directory, and table, that holds the words. */
const ENTRIES = 'entries';

/** What the learner is told about a failed change. */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
}): string {
	if (error.name === 'NotFound')
		return 'The file is no longer here, so nothing was changed.';
	if (error.name === 'InvalidValues' && 'issues' in error)
		return (error.issues as readonly { message: string }[])
			.map((issue) => issue.message)
			.join(' ');
	return error.message;
}

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
	folder: Pick<VocabFolder, 'tables' | 'files'>,
	folder$: Pick<VocabOptions, 'entries' | 'files' | 'write'>,
	queryClient: QueryClient,
	{
		refused,
		onWriteFailed,
	}: {
		/** Why no change starts now, if one does not. */
		refused: () => string | undefined;
		/** A write failed; the app tells the learner. */
		onWriteFailed: (failure: WriteFailure) => void;
	},
) {
	const table = folder.tables.entries;
	const { defineMutation } = createQueryFactories(queryClient);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const listKey = folder$.entries.list.queryKey();
	const textKey = (path: string) => folder$.files.text.queryKey(path);
	/** The word file open as text for repair, if one is, and its typed text. */
	let repair = $state<{ path: string; draft: TextEditor } | undefined>();

	const pathOf = (id: string) => rowPath(table.name, id);
	const listingData = () => queryClient.getQueryData<EntryListing>(listKey);
	/** The text of `path` as the cache holds it, when it opens as text. */
	const shownText = (path: string) => {
		const opened = queryClient.getQueryData<OpenedFile>(textKey(path));
		return opened?.kind === 'text' ? opened.text : undefined;
	};

	/** Whether a delete of `path` is running or waiting, which pauses its edits. */
	const deleting = (path: string) =>
		queryClient.isMutating({
			mutationKey: vocabKeys.delete(path),
			exact: true,
		}) > 0;

	/**
	 * Set fields of a word as its file is now. A failure is reported, and the
	 * card keeps what was typed. A set of a word deleted elsewhere writes
	 * nothing (ADR-0576): it is reported with the note it held, to copy.
	 */
	const setEntry = {
		...folder$.entries.set.mutationOptions(),
		onSuccess: (written, { stem, fields }) => {
			if (written !== null) return;
			const path = pathOf(stem);
			onWriteFailed({
				path,
				error: FileError.NotFound({ path }).error,
				lost: fields.note ?? '',
			});
		},
		onError: (error, { stem }) =>
			onWriteFailed({ path: pathOf(stem), error, lost: '' }),
	} satisfies ReturnType<typeof folder$.entries.set.mutationOptions>;
	const setKey = setEntry.mutationKey ?? [];

	/** Resolves once no set of the word at `id` runs or waits. */
	const setsSettled = (id: string) =>
		whenIdle(queryClient, {
			mutationKey: setKey,
			predicate: (mutation) =>
				(mutation.state.variables as { stem?: string } | undefined)?.stem ===
				id,
		});

	/**
	 * Write repair text of `path`: one run of the folder's write mutation. A
	 * failure keeps the text, to send again. A file deleted elsewhere takes no
	 * repair (ADR-0576): the text typed is offered instead, and let go.
	 */
	async function writeText(
		path: string,
		change: TextChange<string>,
	): Promise<'landed' | 'gone'> {
		const written = await runMutation(
			queryClient,
			{
				...folder$.write.mutationOptions(),
				onError: (error) =>
					onWriteFailed({
						path,
						error,
						lost: '',
						retry: () => void repair?.draft.save(),
					}),
			},
			{ path, ...change },
		);
		if (written.file !== null) return 'landed';
		const lost = repair?.path === path ? repair.draft.typed : undefined;
		if (repair?.path === path) repair.draft.discard();
		onWriteFailed({
			path,
			error: FileError.NotFound({ path }).error,
			lost: lost ?? change.to,
		});
		return 'gone';
	}

	/** Put a word this page just saved into the listing. */
	function received(id: string, stored: StoredRow<EntryFields>) {
		// A read still running may not hold it: read once more instead.
		if (queryClient.isFetching({ queryKey: listKey, exact: true }) > 0)
			return queryClient.invalidateQueries({ queryKey: listKey, exact: true });
		queryClient.setQueryData<EntryListing>(listKey, (listing) =>
			listing === undefined
				? undefined
				: [
						...listing.filter((entry) => entry.stem !== id),
						{ stem: id, result: Ok(stored) },
					],
		);
	}

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
				EntryError
			>
		> => {
			const why = refused();
			if (why !== undefined) return EntryError.NotStarted({ reason: why });
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
		onSuccess: ({ id, stored }) => received(id, stored),
	});

	/** Whether the word at `id` takes an edit now: not closing, deleted, or open as text. */
	function canEdit(id: string) {
		const path = pathOf(id);
		return refused() === undefined && repair?.path !== path && !deleting(path);
	}

	/** Set fields of the word at `id`; answers whether it was sent. */
	function send(id: string, fields: Partial<EntryFields>): boolean {
		if (!canEdit(id)) return false;
		void runMutation(queryClient, setEntry, { stem: id, fields }).catch(
			() => {},
		);
		return true;
	}

	return {
		/** The word listing, narrowed by `select` for one view. */
		entriesQuery<TData = EntryListing>(
			select?: (listing: EntryListing) => TData,
		) {
			return { ...folder$.entries.list.queryOptions(), select };
		},
		/** One word file's exact text, or its type and size when it is not editable text. */
		textQuery: (path: string) => folder$.files.text.queryOptions(path),
		/** The set a card sends a note it holds with: `{ stem, fields }`. */
		setEntry,
		canEdit,
		/** Whether the word at `id` takes no edit now: it is being deleted, or is open as text. */
		isLocked(id: string) {
			trackMutations();
			const path = pathOf(id);
			return repair?.path === path || deleting(path);
		},

		/**
		 * Save a word or a captured phrase, and answer once the folder holds its
		 * file. The text is trimmed and otherwise exact. `present` means a word
		 * with that exact text is already saved and nothing was written. `note`
		 * starts empty and `stage` new: both are the learner's to set.
		 */
		async add(text: string): Promise<Result<'added' | 'present', EntryError>> {
			const { data, error } = await addWord(text);
			return error === null ? Ok(data.outcome) : Err(error);
		},
		/** Send the note of the word at `id`. */
		setNote: (id: string, note: string) => send(id, { note }),
		/** Press a stage of the word at `id`; it is sent at once. */
		setStage: (id: string, stage: EntryFields['stage']) => send(id, { stage }),
		/**
		 * Delete `entry`. It waits for the word's sets under way and writes
		 * the repair text typed, then deletes the file whatever it holds.
		 */
		delete(entry: Entry) {
			const path = pathOf(entry.id);
			return defineMutation({
				mutationKey: vocabKeys.delete(path),
				mutationFn: async (): Promise<
					Result<undefined, WriteError | EntryError>
				> => {
					const why = refused();
					if (why !== undefined) return EntryError.NotStarted({ reason: why });
					await setsSettled(entry.id);
					if (repair?.path === path) await repair.draft.save();
					return table.delete(entry.id);
				},
				onSuccess: () => {
					queryClient.setQueryData<EntryListing>(listKey, (listing) =>
						listing?.filter((listed) => listed.stem !== entry.id),
					);
					queryClient.removeQueries({ queryKey: textKey(path), exact: true });
					if (repair?.path === path) repair = undefined;
				},
			})();
		},

		/** The word file open as text for repair, if one is. */
		get repairing() {
			return repair?.path;
		},
		/** The text typed for the repair and not yet written, if any; read reactively. */
		get repairText() {
			return repair?.draft.typed;
		},
		/** Open a word file as its exact text. */
		openRepair(path: string) {
			repair = {
				path,
				draft: createTextEditor({
					current: () => shownText(path),
					write: (change) => writeText(path, change),
				}),
			};
		},
		/**
		 * Close the repair once its text is written; the write marked the
		 * word stale, so a repaired file shows as a word. Answers whether it
		 * closed: a text that could not be written keeps the repair open.
		 */
		async closeRepair(): Promise<boolean> {
			const open = repair;
			if (open === undefined) return true;
			await open.draft.save();
			if (open.draft.typed !== undefined) return false;
			if (repair === open) repair = undefined;
			queryClient.removeQueries({ queryKey: textKey(open.path), exact: true });
			return true;
		},
		/** Type the text of the word file open for repair; the card writes it after a pause (`saveRepair`). */
		inputText(path: string, text: string) {
			if (refused() !== undefined || deleting(path)) return false;
			if (repair?.path !== path || shownText(path) === undefined) return false;
			repair.draft.change(text);
			return true;
		},
		/** Write the repair text typed, if any; resolves once no write of it runs. */
		saveRepair: () => repair?.draft.save() ?? Promise.resolve(),
	};
}

export type Entries = ReturnType<typeof createEntries>;
