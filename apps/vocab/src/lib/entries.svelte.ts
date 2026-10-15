/**
 * The learner's saved words (ADR-0548).
 *
 * The `entries` table's listing is one query under the folder's keys: the
 * files that read as words, and the ones that do not, each with why, for
 * repair as text. It is read on open and again when the folder reports a
 * change to `entries/`. This page's own saves are not reported: each puts
 * what it wrote in the listing itself.
 *
 * An edit is a draft held outside the cache, one per word. The draft keeps
 * the version the edit started from, so a read that lands meanwhile changes
 * the listing and never the edit. Each change sends a save, one at a time;
 * changes made while a save runs are sent next, from the version it wrote.
 * A file changed elsewhere since is merged with the edit. A failed save
 * keeps the draft on screen, and the learner is told.
 *
 * A word file that is not a valid word is repaired as its exact text, read
 * as its own query and written the same way: a text draft over the version
 * read, saved one write at a time and merged with a change made elsewhere
 * (ADR-0551). A save that replaced another writer's change names it, with
 * a way to put theirs back. Adding and deleting a word are mutations too, so
 * closing waits for them.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive, so two adds of one text reach the same file.
 */

import { InstantString } from '@epicenter/definition/field';
import {
	type FileCapture,
	type FileError,
	hashBytes,
	type Replaced,
	type Row,
	rowPath,
	type StoredRow,
	type TableError,
	type TableListing,
	wellFormed,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import { runMutation, type SaveTextVariables } from '@epicenter/folder/query';
import {
	createDraftState,
	createTextDraftState,
	type DraftState,
	type TextDraftState,
} from '@epicenter/folder/svelte';
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
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

/**
 * A save that replaced a value another writer changed: the word's path,
 * what it replaced, and the one more save that puts theirs back.
 */
export type ReplacedNotice = {
	readonly path: string;
	readonly replaced: readonly Replaced[];
	readonly restore: () => void;
};

/** The directory, and table, that holds the words. */
const ENTRIES = 'entries';

/** What the learner is told about a failed change. */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
}): string {
	if (error.name === 'NotFound')
		return 'The file is no longer here, so nothing was changed.';
	if (error.name === 'Conflict')
		return 'actualSha256' in error && error.actualSha256 === undefined
			? 'The file is no longer here, so nothing was changed.'
			: 'The file changed elsewhere, so nothing was changed. Its current version is shown.';
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
	folder: Pick<VocabFolder, 'tables' | 'files' | 'definition'>,
	folder$: Pick<VocabOptions, 'entries' | 'files' | 'pathFilter'>,
	queryClient: QueryClient,
	{
		refused,
		onWriteFailed,
		onReplaced,
	}: {
		/** Why no change starts now, if one does not. */
		refused: () => string | undefined;
		/** A write failed; the app tells the learner. */
		onWriteFailed: (failure: WriteFailure) => void;
		/** A save replaced a value changed elsewhere; the app tells the learner. */
		onReplaced: (notice: ReplacedNotice) => void;
	},
) {
	const table = folder.tables.entries;
	const { defineMutation } = createQueryFactories(queryClient);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	const listKey = folder$.entries.list.queryKey();
	const textKey = (path: string) => folder$.files.text.queryKey(path);
	/** Each word's edit, by ID; one draft whichever view edits it. */
	const drafts = new SvelteMap<string, DraftState<EntryFields>>();
	/** The word file open as text for repair, if one is, and its typed text. */
	let repair = $state<{ path: string; draft: TextDraftState } | undefined>();

	const pathOf = (id: string) => rowPath(table.name, id);
	const listingData = () => queryClient.getQueryData<EntryListing>(listKey);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(textKey(path));

	/** The word the cache holds at `id`, if it reads as one. */
	function rowOf(id: string): StoredRow<EntryFields> | undefined {
		const result = listingData()?.find((entry) => entry.stem === id)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Whether a delete of `path` is running or waiting, which pauses its edits. */
	const removing = (path: string) =>
		queryClient.isMutating({
			mutationKey: vocabKeys.remove(path),
			exact: true,
		}) > 0;

	/** The draft of the word at `id`, made at its first edit. */
	function draftOf(id: string): DraftState<EntryFields> {
		const known = drafts.get(id);
		if (known !== undefined) return known;
		const path = pathOf(id);
		const draft: DraftState<EntryFields> = createDraftState<EntryFields>({
			save: (sent) =>
				runMutation(
					queryClient,
					{
						...folder$.entries.save.mutationOptions(),
						onError: (error) => {
							// A word deleted elsewhere is gone with its edit.
							if (error.name === 'NotFound') {
								draft.discard();
								onWriteFailed({ path, error, lost: '' });
								return;
							}
							onWriteFailed({
								path,
								error,
								lost: '',
								retry: () => void draft.save(),
							});
						},
					},
					sent,
				),
			onSaved: tell(path),
		});
		drafts.set(id, draft);
		return draft;
	}

	/** What a save of `path` replaced, named with the save that restores it. */
	const tell =
		(path: string) =>
		({ replaced }: { replaced: readonly Replaced[] }, restore: () => void) => {
			if (replaced.length > 0) onReplaced({ path, replaced, restore });
		};

	/** Save repair text of `path`: one run of the files' write mutation. */
	function writeText(path: string, sent: SaveTextVariables) {
		return runMutation(
			queryClient,
			{
				...folder$.files.write.mutationOptions(),
				onError: (error) =>
					onWriteFailed({
						path,
						error,
						lost: '',
						retry: () => void repair?.draft.save(),
					}),
			},
			{ path, ...sent },
		);
	}

	/**
	 * The capture a delete of `id` acts on, read when it runs: the newest
	 * hash the cache holds. A file open as text, or one that is not a valid
	 * word, is a capture of its bytes too.
	 */
	function heldCapture(id: string): FileCapture | undefined {
		const path = pathOf(id);
		const opened = textData(path);
		if (repair?.path === path && opened?.kind === 'text') return opened.file;
		const result = listingData()?.find((entry) => entry.stem === id)?.result;
		if (result?.error === null) return result.data;
		if (result?.error.name === 'InvalidRow') return result.error;
		return undefined;
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
			if (error === null)
				return Ok({ outcome: 'added', id: stem, stored: created });
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
			return Ok({ outcome: 'present', id: stem, stored: current });
		},
		onSuccess: ({ id, stored }) => received(id, stored),
	});

	/** Change the draft of the word at `id` and save it. */
	function edit(id: string, change: (row: Row<EntryFields>) => void): boolean {
		if (refused() !== undefined || repair?.path === pathOf(id)) return false;
		if (removing(pathOf(id))) return false;
		const current = rowOf(id);
		if (current === undefined) return false;
		const draft = draftOf(id);
		draft.change(current, change);
		void draft.save();
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
		/** `entry` as the learner sees it: with its edit, while one is unsaved. Read reactively. */
		shown(entry: Entry): Entry {
			const row = drafts.get(entry.id)?.row;
			return row === undefined
				? entry
				: { ...entry, note: row.fields.note, stage: row.fields.stage };
		},
		/** Whether a save of the word at `id` runs; read reactively. */
		isSaving(id: string) {
			return drafts.get(id)?.saving ?? false;
		},
		/** Whether the word at `id` takes no edit now: it is being deleted, or is open as text. */
		isLocked(id: string) {
			trackMutations();
			const path = pathOf(id);
			return repair?.path === path || removing(path);
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
		/** Type the note of the word at `id`; it is kept well formed, so what is shown is what is saved. */
		inputNote(id: string, note: string) {
			return edit(id, (row) => {
				row.fields.note = wellFormed(note);
			});
		},
		/** Press a stage of the word at `id`. */
		setStage(id: string, stage: EntryFields['stage']) {
			return edit(id, (row) => {
				row.fields.stage = stage;
			});
		},
		/**
		 * Delete `entry`. It waits for the word's save under way, so it removes
		 * what this page saved last; a file changed elsewhere since is refused,
		 * and the list reads it again.
		 */
		remove(entry: Entry) {
			const path = pathOf(entry.id);
			return defineMutation({
				mutationKey: vocabKeys.remove(path),
				mutationFn: async (): Promise<
					Result<undefined, TableError | FileError | EntryError>
				> => {
					const why = refused();
					if (why !== undefined) return EntryError.NotStarted({ reason: why });
					await drafts.get(entry.id)?.save();
					if (repair?.path === path) await repair.draft.save();
					return table.delete(heldCapture(entry.id) ?? entry.stored);
				},
				onSuccess: () => {
					queryClient.setQueryData<EntryListing>(listKey, (listing) =>
						listing?.filter((listed) => listed.stem !== entry.id),
					);
					queryClient.removeQueries({ queryKey: textKey(path), exact: true });
					drafts.delete(entry.id);
					if (repair?.path === path) repair = undefined;
				},
				onError: (error) => {
					if (error.name === 'Conflict')
						return queryClient.invalidateQueries(folder$.pathFilter([path]));
				},
			})();
		},

		/** The word file open as text for repair, if one is. */
		get repairing() {
			return repair?.path;
		},
		/** The text typed for the repair and not yet written, if any; read reactively. */
		get repairText() {
			return repair?.draft.text;
		},
		/** Open a word file as its exact text. */
		openRepair(path: string) {
			repair = {
				path,
				draft: createTextDraftState({
					save: (sent) => writeText(path, sent),
					onSaved: tell(path),
					definition: folder.definition,
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
			if (open.draft.text !== undefined) return false;
			if (repair === open) repair = undefined;
			queryClient.removeQueries({ queryKey: textKey(open.path), exact: true });
			return true;
		},
		/** Type the text of the word file open for repair; each change is written as typed. */
		inputText(path: string, text: string) {
			if (refused() !== undefined || removing(path)) return false;
			const opened = textData(path);
			if (repair?.path !== path || opened?.kind !== 'text') return false;
			repair.draft.change(opened.file, text);
			void repair.draft.save();
			return true;
		},
	};
}

export type Entries = ReturnType<typeof createEntries>;
