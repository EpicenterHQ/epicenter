/**
 * The Capture product state over one opened folder, kept in a TanStack Query
 * cache (ADR-0528) through the folder's query options (ADR-0548).
 *
 * Reads are queries keyed under the folder (`folderOptions`): the capture
 * listing, which the timeline and the capture view both read, and the exact
 * text of a capture opened as text. Changes made outside this page arrive on
 * `folder.onFilesChanged`, which the page wires to the cache once; nothing
 * here reads again on focus. The page's own writes keep the cache in step
 * themselves: each puts its result in the cache and marks stale what else
 * it changed, such as the listing a capture file's text decides.
 *
 * An edit of a capture is a draft its form holds (`formOf`): the version it
 * started from and the edited row, outside the cache, saved one save at a
 * time and merged by the folder with whatever changed since. A failed save
 * keeps the draft and is reported. An edit of a file's text is a text draft
 * held the same way, saved over the version it started from and merged by
 * line with whatever changed since (ADR-0551). A save that replaced another
 * writer's change names it, with a way to put theirs back. A text save that
 * fails drops the typed text, reads the file again, and reports the text
 * that was not written.
 *
 * Every other action is a mutation too: create, delete, Save version, and
 * the import of old captures. Closing fences new input, then waits for the
 * edits held and every mutation. Quitting Epicenter asks nothing (ADR-0542).
 * Saves never commit (ADR-0529); a version is recorded only by Save version.
 *
 * Input not committed yet is `$state`: the New capture text, and for each
 * capture its thought typed and not added and its thought being edited
 * (`formOf`). Those stay while the person moves between captures.
 */

import {
	CAPTURES_TABLE,
	type CaptureFields,
	captureBody,
	captureDefinition,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import {
	type CommitOutcome,
	type FileCapture,
	type FileError,
	type FileSaveError,
	formatRow,
	type Replaced,
	type Row,
	type RowReadError,
	restoreTheirs,
	rowPath,
	rowStemOf,
	type SavedFile,
	type SavedRow,
	type StoredRow,
	type TableCreateError,
	type TableError,
	type TableListing,
	type TableSaveError,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import { folderOptions, runMutation, whenIdle } from '@epicenter/folder/query';
import {
	createTextDraftState,
	type TextDraftState,
} from '@epicenter/folder/svelte';
import type { QueryClient } from '@tanstack/svelte-query';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type CaptureForm, createCaptureForm } from './capture-form.svelte.js';
import type { CaptureHost } from './platform/types.js';

export type Captures = ReturnType<typeof createCaptures>;

/** Every capture file, as the table lists it: a row, or why it is not one. */
export type CaptureListing = TableListing<CaptureFields>;

/** How a capture is open: its text and thoughts, or its exact Markdown. */
export type Mode = 'capture' | 'text';

/** Which capture the detail shows, and how. */
export type Opened = { readonly stem: string; readonly mode: Mode };

/** A capture the timeline lists. */
export type TimelineRow = {
	readonly stem: string;
	readonly path: string;
	/** `undefined` when `capturedAt` is not a date and time this page can read. */
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
};

/** A capture file the timeline cannot show, and why, for repair as text. */
export type Repair = {
	readonly stem: string;
	readonly path: string;
	readonly problem: string;
};

/** What a confirmed deletion removes, as the person was asked about it. */
export type Deletion = {
	readonly stem: string;
	readonly path: string;
	/** What the dialog names: the start of the capture's text, if it reads as one. */
	readonly title: string;
	/** The file as it was when the person was asked, for a file no view holds. */
	readonly capture: FileCapture;
	/**
	 * Whether the file has changes that are in no saved version, as Git
	 * status last checked; `undefined` when the check failed.
	 */
	readonly unversioned: boolean | undefined;
};

/**
 * A write that failed. A capture's edit stays on screen, and the next change
 * saves it again; a file's text is dropped for the file as it is now.
 */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError | FileSaveError;
	/** The text that was on screen and is not in the file. */
	readonly text: string;
};

/**
 * A save that landed over a change made elsewhere: what of it the edit
 * replaced, and the one more save that puts theirs back.
 */
export type ReplacedChange = {
	readonly path: string;
	readonly replaced: readonly Replaced[];
	readonly restore: () => void;
};

/** Why an action did not start. */
export const CapturesError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
});
export type CapturesError = InferErrors<typeof CapturesError>;

const CLOSING = 'Capture is closing, so nothing was changed.';

/**
 * Cache identity for the app's own actions. Every read, and every save or
 * write of a file, is keyed under the folder (`folderOptions`).
 */
export const capturesKeys = defineKeys({
	all: ['captures'],
	create: ['captures', 'create'],
	remove: (path: string) => ['captures', 'remove', path] as const,
	saveVersion: ['captures', 'save-version'],
});

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A lost reply leaves the outcome unknown.
 */
export function describeError(
	error: FileError | TableError | CapturesError,
): string {
	switch (error.name) {
		case 'NotStarted':
			return error.reason;
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Its current version is shown.';
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`;
		case 'InvalidValues':
			return error.issues.map((issue) => issue.message).join(' ');
		default:
			return error.message;
	}
}

/** A readable, sortable stem: the capture's UTC time and a short random suffix. */
function newStem(at: Date): string {
	const stamp = at
		.toISOString()
		.slice(0, 19)
		.replace(/[-:]/g, '')
		.replace('T', '-');
	const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
		byte.toString(36).padStart(2, '0'),
	)
		.join('')
		.slice(0, 5);
	return `${stamp}-${suffix}`;
}

/** The instant of a `capturedAt` value, or `undefined` when it is not one. */
export function instantOf(value: unknown): Date | undefined {
	if (typeof value !== 'string') return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

/** Newest first by the instant, not the text: offsets differ between files. */
function newestFirst(left: TimelineRow, right: TimelineRow) {
	const a = left.capturedAt?.getTime();
	const b = right.capturedAt?.getTime();
	if (a !== b) {
		if (a === undefined) return 1;
		if (b === undefined) return -1;
		return b - a;
	}
	return left.stem < right.stem ? -1 : left.stem > right.stem ? 1 : 0;
}

function byPath(left: { path: string }, right: { path: string }) {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Why a listed file has no row to show. */
function readProblem(error: RowReadError): string {
	if (error.name === 'InvalidRow')
		return error.issues.map((issue) => issue.message).join(' ');
	if (error.name === 'InvalidUtf8') return 'It is not UTF-8 text.';
	return error.message;
}

/**
 * The listing as the timeline shows it: captures newest first, files to
 * repair as text, and files that could not be read at all.
 */
export function timelineOf(listing: CaptureListing) {
	const rows: TimelineRow[] = [];
	const repairs: Repair[] = [];
	const unreadable: { path: string; message: string }[] = [];
	for (const { stem, result } of listing) {
		const path = rowPath(CAPTURES_TABLE, stem);
		if (result.error?.name === 'InvalidRow') {
			repairs.push({ stem, path, problem: readProblem(result.error) });
			continue;
		}
		if (result.error !== null) {
			unreadable.push({ path, message: readProblem(result.error) });
			continue;
		}
		const { row } = result.data;
		const { data: body, error: refusal } = captureBody.decode(row.body);
		if (refusal !== null) {
			repairs.push({ stem, path, problem: refusal.message });
			continue;
		}
		rows.push({
			stem,
			path,
			capturedAt: instantOf(row.fields.capturedAt),
			preview: excerpt(body.text),
			thoughtCount: body.thoughts.length,
		});
	}
	return {
		rows: rows.sort(newestFirst),
		repairs: repairs.sort(byPath),
		unreadable: unreadable.sort(byPath),
	};
}

export function createCaptures(
	host: Pick<CaptureHost, 'folder' | 'location'>,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
		onReplaced = () => {},
	}: {
		/** A write failed; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
		/** A save replaced a change made elsewhere; the app tells the person. */
		onReplaced?: (change: ReplacedChange) => void;
	} = {},
) {
	const { folder } = host;
	const folder$ = folderOptions(folder);
	const table = folder.tables.captures;
	const pathOf = (stem: string) => rowPath(CAPTURES_TABLE, stem);
	const { defineMutation } = createQueryFactories(queryClient);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	const trackMutations = createSubscriber((update) =>
		queryClient.getMutationCache().subscribe(update),
	);

	/** What the detail shows. */
	let opened = $state.raw<Opened | undefined>();
	/** The New capture text, typed and not added. */
	let newCapture = $state('');
	/** Each capture's edit and input not committed yet, kept while the person moves between captures. */
	const forms = new SvelteMap<string, CaptureForm>();
	/** Each file's text edit: the version it started from, and the text typed. */
	const texts = new SvelteMap<string, TextDraftState>();
	let closing: Promise<void> | undefined;
	let closed = $state(false);

	/** Why no edit or action starts now, if one does not. */
	function refused(): string | undefined {
		return closed ? CLOSING : undefined;
	}

	// The app's own actions are local like the folder's writes: nothing
	// waits for a network or retries.
	queryClient.setMutationDefaults(capturesKeys.all, {
		networkMode: 'always',
		retry: false,
	});

	const listKey = folder$.captures.list.queryKey();
	/** Saves of a capture and writes of a file's text, the header's Saving… */
	const writeKeys = [
		folder$.captures.save.mutationOptions().mutationKey,
		folder$.files.write.mutationOptions().mutationKey,
	];
	const writing = () =>
		writeKeys.some(
			(mutationKey) => queryClient.isMutating({ mutationKey }) > 0,
		);

	const rowsData = () => queryClient.getQueryData<CaptureListing>(listKey);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(folder$.files.text.queryKey(path));

	/** The row the cache holds for `stem`, if it reads as a row. */
	function rowOf(stem: string): StoredRow<CaptureFields> | undefined {
		const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Whether a delete of `path` is running, which pauses its edits. */
	const removing = (path: string) =>
		queryClient.isMutating({
			mutationKey: capturesKeys.remove(path),
			exact: true,
		}) > 0;

	/** The text a person would lose with a capture that could not be written. */
	function rowText(row: Row<CaptureFields>) {
		return formatRow(captureDefinition.tables.captures, row).data ?? row.body;
	}

	/** The input not committed yet, and the edit, for the capture at `stem`. */
	function formOf(stem: string): CaptureForm {
		const existing = forms.get(stem);
		if (existing !== undefined) return existing;
		const path = pathOf(stem);
		const form: CaptureForm = createCaptureForm({
			stored: () => rowOf(stem),
			save: (sent) =>
				runMutation(
					queryClient,
					folder$.captures.save.mutationOptions(),
					sent,
				).catch((error: TableSaveError) => {
					const text = rowText(form.draft ?? sent.row);
					// The file is gone: the edit has nowhere to go but the notice.
					if (error.name === 'NotFound') form.discard();
					onWriteFailed({ path, error, text });
					throw error;
				}),
			onSaved: (saved) => savedRow(path, saved),
			locked: () => refused() !== undefined || removing(path),
		});
		forms.set(stem, form);
		return form;
	}

	/** A capture's save landed: what it replaced is named. */
	function savedRow(path: string, saved: SavedRow<CaptureFields>) {
		if (saved.replaced.length === 0) return;
		onReplaced({
			path,
			replaced: saved.replaced,
			restore: () =>
				void runMutation(
					queryClient,
					folder$.captures.save.mutationOptions(),
					restoreTheirs(saved),
				)
					.then((restored) => savedRow(path, restored))
					.catch(() => {}),
		});
	}

	/** A text save landed: what it replaced is named. */
	function savedText(path: string, saved: SavedFile) {
		if (saved.replaced.length === 0) return;
		onReplaced({
			path,
			replaced: saved.replaced,
			restore: () => {
				const { base, content } = restoreTheirs(saved);
				void runMutation(queryClient, folder$.files.write.mutationOptions(), {
					path,
					content,
					base,
				})
					.then((restored) => savedText(path, restored))
					.catch(() => {});
			},
		});
	}

	/** The text edit of `path`, made at its first change. */
	function textDraftOf(path: string): TextDraftState {
		const known = texts.get(path);
		if (known !== undefined) return known;
		const draft = createTextDraftState({
			save: ({ base, text }) =>
				runMutation(queryClient, folder$.files.write.mutationOptions(), {
					path,
					content: text,
					base,
				}).catch((error: FileSaveError) => {
					// The save neither landed nor merged: the typed text gives way
					// to the file as it is now, read again, and the notice offers it.
					const lost = draft.text ?? text;
					draft.discard();
					texts.delete(path);
					onWriteFailed({ path, error, text: lost });
					throw error;
				}),
			onSaved: (saved) => savedText(path, saved),
		});
		texts.set(path, draft);
		return draft;
	}

	/** Save the text edit of `path` until none is left; then it is done. */
	async function writeText(path: string): Promise<void> {
		const draft = texts.get(path);
		if (draft === undefined) return;
		await draft.save();
		if (draft.text === undefined && texts.get(path) === draft)
			texts.delete(path);
	}

	/**
	 * Replace the text of `path` and write it, over the version the view
	 * showed when typing started. Refused while closing, while the file is
	 * being deleted, and when the file is not open as text.
	 */
	function editText(path: string, text: string): boolean {
		if (refused() !== undefined || removing(path)) return false;
		const file = textData(path);
		// The first change starts from the file shown; later ones keep their base.
		const base =
			texts.get(path)?.base ?? (file?.kind === 'text' ? file.file : undefined);
		if (base === undefined) return false;
		textDraftOf(path).change(base, text);
		void writeText(path);
		return true;
	}

	/** Resolves once every edit held has been sent and its writes have landed. */
	const editsSettled = () =>
		Promise.all([
			...[...forms.values()].map((form) => form.flush()),
			...[...texts.keys()].map(writeText),
		]);

	/** How many captures hold a thought typed and not added, a changed thought edit, or an edit not saved. */
	const unsentForms = () =>
		[...forms.values()].filter(
			(form) => form.unsent || form.draft !== undefined,
		).length;

	/**
	 * The capture a delete of `path` acts on, read when it runs: the newest
	 * version the cache holds for what the app edits, if it holds one.
	 */
	function heldCapture(stem: string): FileCapture | undefined {
		const path = pathOf(stem);
		if (opened?.stem === stem && opened.mode === 'text') {
			const file = textData(path);
			return file?.kind === 'text' ? file.file : undefined;
		}
		const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
		if (result?.error === null) return result.data;
		if (result?.error.name === 'InvalidRow') return result.error;
		return undefined;
	}

	/**
	 * Show `stem` as `mode` edits it. A capture that is not a valid one opens
	 * as text. Coming from its text, the text's writes land first and the
	 * listing is read again, so the view shows what was typed there.
	 */
	async function open(stem: string, mode: Mode) {
		const path = pathOf(stem);
		if (
			mode === 'capture' &&
			opened?.stem === stem &&
			opened.mode === 'text' &&
			refused() === undefined
		) {
			await writeText(path);
			await queryClient.refetchQueries({ queryKey: listKey, exact: true });
		}
		let as = mode;
		if (mode === 'capture') {
			const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
			if (
				result !== undefined &&
				(result.error !== null ||
					captureBody.decode(result.data.row.body).error !== null)
			)
				as = 'text';
		}
		// The view reads the file when it opens, unless its text is still being written.
		if (as === 'text' && !texts.has(path))
			queryClient.removeQueries({
				queryKey: folder$.files.text.queryKey(path),
				exact: true,
			});
		opened = { stem, mode: as };
	}

	return {
		location: host.location,
		folder,
		/** The folder's query options: every read the views show is keyed under it. */
		folder$,
		queryClient,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** Closing refuses input and actions. */
		get fenced() {
			return closed;
		},
		/** Whether a save of a capture or a write of a file's text is running, read reactively. */
		get saving() {
			trackMutations();
			return writing();
		},
		/** Whether `path` is being deleted, which pauses its edits; read reactively. */
		isRemoving(path: string) {
			trackMutations();
			return removing(path);
		},
		/** Whether a browser reload now could lose anything: an action running, or text not saved or added. */
		get unsettled() {
			trackMutations();
			return (
				queryClient.isMutating() > 0 ||
				newCapture !== '' ||
				[...texts.values()].some((draft) => draft.text !== undefined) ||
				unsentForms() > 0
			);
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The capture listing, narrowed by `select` for one view. */
		rowsQuery<TData = CaptureListing>(
			select?: (listing: CaptureListing) => TData,
		) {
			return { ...folder$.captures.list.queryOptions(), select };
		},
		/** The text typed for `path` and not written yet, read reactively. */
		typedText(path: string): string | undefined {
			return texts.get(path)?.text;
		},

		// ------------------------------------------------------------------
		// What the detail shows
		// ------------------------------------------------------------------

		/** The open capture, or `undefined` for the timeline. */
		get opened() {
			return opened;
		},
		open,
		/** Back to the timeline. Saves go on landing; nothing waits or asks. */
		leave() {
			opened = undefined;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		editText,
		formOf,

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		get newCapture() {
			return newCapture;
		},
		inputNewCapture(value: string) {
			if (refused() === undefined) newCapture = value;
		},
		/**
		 * Save `text` as a new capture file and open it. The New capture text
		 * stays in the form when this fails.
		 */
		create: defineMutation({
			mutationKey: capturesKeys.create,
			mutationFn: async (
				text: string,
			): Promise<
				Result<StoredRow<CaptureFields>, TableCreateError | CapturesError>
			> => {
				const why = refused();
				if (why !== undefined) return CapturesError.NotStarted({ reason: why });
				// Blank text is refused and stays in the form: only the person clears it.
				if (text.trim() === '')
					return CapturesError.NotStarted({ reason: 'Write something first.' });
				const now = new Date();
				const { body } = composeBody(text);
				for (let attempt = 0; ; attempt++) {
					const created = await table.create(
						{
							fields: {
								capturedAt: now.toISOString() as CaptureFields['capturedAt'],
							},
							body,
						},
						{ stem: newStem(now) },
					);
					// Another capture took this name: a new one is tried.
					if (created.error?.name !== 'Exists' || attempt >= 3) return created;
				}
			},
			onSuccess: (created, text) => {
				const stem = rowStemOf(CAPTURES_TABLE, created.path);
				if (newCapture === text) newCapture = '';
				if (stem === undefined) return;
				queryClient.setQueryData<CaptureListing>(
					listKey,
					(entries) => entries && [...entries, { stem, result: Ok(created) }],
				);
				// Text that does not read as text and thoughts opens as text.
				void open(stem, 'capture');
			},
		}),
		/**
		 * What deleting the capture at `stem` would remove, for the person to
		 * confirm, and whether its latest changes are in no saved version.
		 */
		async deletionFor(
			stem: string,
		): Promise<Result<Deletion, FileError | CapturesError>> {
			const why = refused();
			if (why !== undefined) return CapturesError.NotStarted({ reason: why });
			const path = pathOf(stem);
			const { data: read, error } = await folder.files.read(path);
			if (error !== null) return Err(error);
			const status = await folder.git.status().then(
				(observed) => observed.data ?? undefined,
				() => undefined,
			);
			const body = (forms.get(stem)?.draft ?? rowOf(stem)?.row)?.body;
			const text =
				body === undefined ? undefined : captureBody.decode(body).data?.text;
			return Ok({
				stem,
				path,
				title: text?.trim().slice(0, 60) ?? '',
				capture: { path: read.path, sha256: read.sha256 },
				unversioned: status?.changes.some((change) => change.path === path),
			});
		},
		/**
		 * Delete what was confirmed. It runs after the capture's edits held
		 * here are written, so it removes what this window saved last; a file
		 * another program changed since is refused, and read again.
		 */
		remove(deletion: Deletion) {
			return defineMutation({
				mutationKey: capturesKeys.remove(deletion.path),
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | CapturesError>
				> => {
					const why = refused();
					if (why !== undefined)
						return CapturesError.NotStarted({ reason: why });
					await Promise.all([
						forms.get(deletion.stem)?.flush(),
						writeText(deletion.path),
					]);
					return table.delete(heldCapture(deletion.stem) ?? deletion.capture);
				},
				onSuccess: () => {
					queryClient.setQueryData<CaptureListing>(listKey, (entries) =>
						entries?.filter((entry) => entry.stem !== deletion.stem),
					);
					queryClient.removeQueries({
						queryKey: folder$.files.text.queryKey(deletion.path),
						exact: true,
					});
					forms.delete(deletion.stem);
					if (opened?.stem === deletion.stem) opened = undefined;
				},
				onError: () =>
					queryClient.invalidateQueries(folder$.pathFilter([deletion.path])),
			})();
		},
		/**
		 * Record a version: commit the saved files (ADR-0529). Edits still
		 * being written land first. Capture has no remote, so nothing is pushed.
		 */
		saveVersion: defineMutation({
			mutationKey: capturesKeys.saveVersion,
			mutationFn: async (): Promise<Result<CommitOutcome, CapturesError>> => {
				const why = refused();
				if (why !== undefined) return CapturesError.NotStarted({ reason: why });
				await editsSettled();
				return Ok(await folder.git.commit());
			},
		}),

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		/**
		 * Fence new input, then wait until every edit held is written and
		 * nothing is mutating before the page releases its folder. Every call
		 * answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			closing = (async () => {
				await editsSettled();
				await whenIdle(queryClient);
				await queryClient.cancelQueries({ queryKey: folder$.key });
			})();
			return closing;
		},
	};
}
