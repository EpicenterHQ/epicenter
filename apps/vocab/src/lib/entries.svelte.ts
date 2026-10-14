/**
 * The learner's saved words, kept in the TanStack Query cache (ADR-0528).
 *
 * The `entries` table's listing is one query: the files that read as words,
 * and the ones that do not, each with why, for repair as text. It is read on
 * open, on window focus while nothing is being written, and after the app's
 * own actions.
 *
 * An edit goes straight into the cache: one immutable `map` over the listing
 * changes one word. Each edit is written by a mutation scoped to the word's
 * file, so a file has at most one write running and one waiting, and the
 * waiting one saves whatever the cache holds when it runs, guarded by the
 * newest confirmed `sha256`. A write that succeeds moves the guard forward. A
 * write that fails reads that one file again, which rolls the edit back, and
 * reports the text that was lost.
 *
 * A word file that is not a valid word is repaired as its exact text, read
 * as its own query and written the same way. Adding and deleting a word are
 * mutations too, so closing waits for them.
 *
 * A new word's file is named by the SHA-256 of its exact text, and creation
 * is exclusive, so two adds of one text reach the same file.
 */

import { InstantString } from '@epicenter/definition/field';
import {
	type FileCapture,
	type FileError,
	formatRow,
	hashBytes,
	type Row,
	rowPath,
	type StoredRow,
	type TableError,
	type TableListing,
	wellFormed,
} from '@epicenter/folder';
import { type OpenedFile, readTextFile } from '@epicenter/folder/file-browser';
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber } from 'svelte/reactivity';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createQueryFactories, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Entry,
	type EntryFields,
	readEntry,
	readRows,
	type UnreadableFile,
	type VocabFolder,
	vocabFolder,
} from './data.js';
import { vocabKeys, type WriteFailure, writing } from './query.js';

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

/** Word files larger than this are named for repair but not opened as text. */
const EDITABLE_TEXT_LIMIT = 1024 * 1024;

/** What the learner is told about a failed change. */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
}): string {
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
	folder: Pick<VocabFolder, 'tables' | 'files'>,
	queryClient: QueryClient,
	{
		refused,
		onWriteFailed,
	}: {
		/** Why no change starts now, if one does not. */
		refused: () => string | undefined;
		/** A write failed and was rolled back; the app tells the learner. */
		onWriteFailed: (failure: WriteFailure) => void;
	},
) {
	const table = folder.tables.entries;
	const { defineMutation } = createQueryFactories(queryClient);
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);
	/** The word file open as text for repair, if one is. */
	let repairing = $state<string | undefined>();

	const pathOf = (id: string) => rowPath(table.name, id);
	const listingData = () =>
		queryClient.getQueryData<EntryListing>(vocabKeys.entries);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(vocabKeys.text(path));

	/** The word the cache holds at `id`, if it reads as one. */
	function rowOf(id: string): StoredRow<EntryFields> | undefined {
		const result = listingData()?.find((entry) => entry.stem === id)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Change the word at `id` in the cache: one immutable `map` over the listing. */
	function mapRow(
		id: string,
		change: (stored: StoredRow<EntryFields>) => StoredRow<EntryFields>,
	): boolean {
		let changed = false;
		queryClient.setQueryData<EntryListing>(vocabKeys.entries, (listing) =>
			listing?.map((entry) => {
				if (entry.stem !== id || entry.result.error !== null) return entry;
				changed = true;
				return { ...entry, result: Ok(change(entry.result.data)) };
			}),
		);
		return changed;
	}

	/** Change the text of `path` in the cache, if it holds text. */
	function mapText(
		path: string,
		change: (file: { path: string; sha256: string; text: string }) => {
			path: string;
			sha256: string;
			text: string;
		},
	): boolean {
		let changed = false;
		queryClient.setQueryData<OpenedFile>(vocabKeys.text(path), (opened) => {
			if (opened?.kind !== 'text') return opened;
			changed = true;
			return { kind: 'text', file: change(opened.file) };
		});
		return changed;
	}

	/** Whether a delete of `path` is running or waiting, which pauses its edits. */
	const removing = (path: string) =>
		queryClient.isMutating({
			mutationKey: vocabKeys.remove(path),
			exact: true,
		}) > 0;

	/** Whether fewer than two writes under `key` run or wait, so an edit should queue one. */
	const needsWrite = (key: readonly unknown[]) =>
		queryClient.isMutating({ mutationKey: key, exact: true }) < 2;

	/**
	 * Read again what an action may have changed. While a write runs nothing
	 * is read: the last write to settle reads everything again.
	 */
	const invalidate = (queryKey: readonly unknown[]) =>
		writing(queryClient)
			? Promise.resolve()
			: queryClient.invalidateQueries({ queryKey });

	/** After a write settles: once it is the last one, the words and any repair are read again. */
	const afterWrite = () =>
		queryClient.isMutating({ mutationKey: vocabKeys.writes }) <= 1
			? Promise.all([
					queryClient.invalidateQueries({ queryKey: vocabKeys.entries }),
					queryClient.invalidateQueries({ queryKey: ['vocab', 'text'] }),
				])
			: undefined;

	/**
	 * After a failed write, the cache takes the word as the file holds it
	 * now. TanStack awaits this before the next write of the file runs, so
	 * that write saves the file's own bytes instead of the failed edit.
	 */
	async function reloadRow(id: string) {
		await queryClient.cancelQueries({
			queryKey: vocabKeys.entries,
			exact: true,
		});
		const { data: stored, error } = await table.get(id);
		queryClient.setQueryData<EntryListing>(vocabKeys.entries, (listing) =>
			listing?.flatMap((entry) => {
				if (entry.stem !== id) return [entry];
				if (error !== null) return [{ stem: id, result: Err(error) }];
				return stored === undefined ? [] : [{ stem: id, result: Ok(stored) }];
			}),
		);
	}

	/** After a failed write of a file's text, the cache takes the file as it is now. */
	async function reloadText(path: string) {
		const key = vocabKeys.text(path);
		await queryClient.cancelQueries({ queryKey: key, exact: true });
		const read = await readTextFile(folder.files, path, EDITABLE_TEXT_LIMIT);
		if (read.error === null) queryClient.setQueryData(key, read.data);
		else await queryClient.invalidateQueries({ queryKey: key, exact: true });
	}

	/**
	 * The capture a delete of `id` acts on, read when it runs: the newest
	 * hash the cache confirmed, if it holds one. A file open as text, or one
	 * that is not a valid word, is a capture of its bytes too.
	 */
	function heldCapture(id: string): FileCapture | undefined {
		const path = pathOf(id);
		const opened = textData(path);
		if (repairing === path && opened?.kind === 'text') return opened.file;
		const result = listingData()?.find((entry) => entry.stem === id)?.result;
		if (result?.error === null) return result.data;
		if (result?.error.name === 'InvalidRow') return result.error;
		return undefined;
	}

	/** The write of one word: the row the cache holds when it runs, guarded by the hash it last confirmed. */
	function rowWrite(id: string) {
		const path = pathOf(id);
		return {
			mutationKey: vocabKeys.write(path),
			// Row and text writes of one file share its queue.
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<
					StoredRow<EntryFields> | undefined,
					Extract<TableError, { name: 'InvalidValues' }> | FileError
				>
			> => {
				const stored = rowOf(id);
				if (stored === undefined) return Ok(undefined);
				return table.replace(stored, stored.row);
			},
			onSuccess: (saved: StoredRow<EntryFields> | undefined) => {
				if (saved === undefined) return;
				// TanStack awaits this before the next write in the scope runs.
				mapRow(id, (stored) => ({
					...stored,
					path: saved.path,
					sha256: saved.sha256,
				}));
			},
			onError: async (
				error: Extract<TableError, { name: 'InvalidValues' }> | FileError,
			) => {
				const lost = rowOf(id);
				await reloadRow(id);
				onWriteFailed({
					path,
					error,
					lost: lost === undefined ? '' : rowText(lost.row),
				});
			},
			onSettled: afterWrite,
		};
	}

	/** The write of a word file's text, as `rowWrite` is for a word. */
	function textWrite(path: string) {
		return {
			mutationKey: vocabKeys.writeText(path),
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<FileCapture | undefined, FileError>
			> => {
				const opened = textData(path);
				if (opened?.kind !== 'text') return Ok(undefined);
				return folder.files.replace(opened.file, opened.file.text);
			},
			onSuccess: (saved: FileCapture | undefined) => {
				if (saved === undefined) return;
				mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
			},
			onError: async (error: FileError) => {
				const lost = textData(path);
				await reloadText(path);
				onWriteFailed({
					path,
					error,
					lost: lost?.kind === 'text' ? lost.file.text : '',
				});
			},
			onSettled: afterWrite,
		};
	}

	/** After a delete: the cache and the repair let the file go. */
	function deleted(id: string) {
		const path = pathOf(id);
		queryClient.setQueryData<EntryListing>(vocabKeys.entries, (listing) =>
			listing?.filter((entry) => entry.stem !== id),
		);
		queryClient.removeQueries({ queryKey: vocabKeys.text(path), exact: true });
		if (repairing === path) repairing = undefined;
	}

	/** Put a word this page just saved into the listing. */
	async function received(id: string, stored: StoredRow<EntryFields>) {
		// A read still running may not hold it.
		await queryClient.cancelQueries({
			queryKey: vocabKeys.entries,
			exact: true,
		});
		queryClient.setQueryData<EntryListing>(vocabKeys.entries, (listing) =>
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
		onSettled: () => invalidate(vocabKeys.entries),
	});

	/** Change the word at `id` in the cache, and queue its write when one is needed. */
	function update(
		id: string,
		change: (row: Row<EntryFields>) => Row<EntryFields>,
	): boolean {
		const path = pathOf(id);
		if (refused() !== undefined || repairing === path || removing(path))
			return false;
		// A read still running could replace this edit when it lands.
		void queryClient.cancelQueries({
			queryKey: vocabKeys.entries,
			exact: true,
		});
		const changed = mapRow(id, (stored) => ({
			...stored,
			row: change(stored.row),
		}));
		if (!changed) return false;
		if (needsWrite(vocabKeys.write(path))) void defineMutation(rowWrite(id))();
		return true;
	}

	return {
		/** The word listing, narrowed by `select` for one view. */
		entriesQuery<TData = EntryListing>(
			select?: (listing: EntryListing) => TData,
		) {
			return resultQueryOptions({
				queryKey: vocabKeys.entries,
				queryFn: () => table.list(),
				select,
			});
		},
		/** One word file's exact text, or its type and size when it is not editable text. */
		textQuery(path: string) {
			return resultQueryOptions({
				queryKey: vocabKeys.text(path),
				queryFn: () => readTextFile(folder.files, path, EDITABLE_TEXT_LIMIT),
			});
		},
		/** Whether a write of the word at `id` runs or waits; read reactively. */
		isSaving(id: string) {
			trackMutations();
			const path = pathOf(id);
			return (
				queryClient.isMutating({ mutationKey: vocabKeys.write(path) }) +
					queryClient.isMutating({ mutationKey: vocabKeys.writeText(path) }) >
				0
			);
		},
		/** Whether the word at `id` takes no edit now: it is being deleted, or is open as text. */
		isLocked(id: string) {
			trackMutations();
			const path = pathOf(id);
			return repairing === path || removing(path);
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
			return update(id, (row) => ({
				...row,
				fields: { ...row.fields, note: wellFormed(note) },
			}));
		},
		/** Press a stage of the word at `id`. */
		setStage(id: string, stage: EntryFields['stage']) {
			return update(id, (row) => ({
				...row,
				fields: { ...row.fields, stage },
			}));
		},
		/**
		 * Delete `entry`. It runs after the word's queued writes, so it removes
		 * what this page saved last; a file changed elsewhere since is refused,
		 * and the list reads it again.
		 */
		remove(entry: Entry) {
			const path = pathOf(entry.id);
			return defineMutation({
				mutationKey: vocabKeys.remove(path),
				scope: { id: path },
				mutationFn: async (): Promise<
					Result<undefined, TableError | FileError | EntryError>
				> => {
					const why = refused();
					if (why !== undefined) return EntryError.NotStarted({ reason: why });
					return table.delete(heldCapture(entry.id) ?? entry.stored);
				},
				onSuccess: () => deleted(entry.id),
				onSettled: () => invalidate(vocabKeys.entries),
			})();
		},

		/** The word file open as text for repair, if one is. */
		get repairing() {
			return repairing;
		},
		/** Open a word file as its exact text, read now. */
		openRepair(path: string) {
			repairing = path;
			void queryClient.invalidateQueries({
				queryKey: vocabKeys.text(path),
				exact: true,
			});
		},
		/** Close the repair and read the words again, so a repaired file shows as a word. */
		closeRepair() {
			repairing = undefined;
			void invalidate(vocabKeys.entries);
		},
		/** Type the text of the word file open for repair; each change is written as typed. */
		inputText(path: string, text: string) {
			if (refused() !== undefined || removing(path)) return false;
			void queryClient.cancelQueries({
				queryKey: vocabKeys.text(path),
				exact: true,
			});
			if (!mapText(path, (file) => ({ ...file, text }))) return false;
			if (needsWrite(vocabKeys.writeText(path)))
				void defineMutation(textWrite(path))();
			return true;
		},
	};
}

/** The text a learner loses with a word that could not be written. */
function rowText(row: Row<EntryFields>) {
	return formatRow(vocabFolder.tables.entries, row).data ?? row.fields.note;
}

export type Entries = ReturnType<typeof createEntries>;
