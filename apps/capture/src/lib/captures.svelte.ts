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
 * A capture's body is a document, so an edit of it is the row's body draft
 * its form types into (`formOf`), and an edit of a file's exact text is its
 * text draft: the folder's edit layer (`edits`) holds each outside the
 * cache, saves it a second after the last change, or when the person
 * leaves it (`flush`, `saveText`), one save at a time as the change from
 * where it started, merged by the folder, by line, with whatever changed
 * since (ADR-0551, ADR-0576); a thought command saves at once. Where a save
 * meets another writer's change to the same line, the save wins, with no
 * notice. A failed save keeps the edit on screen and is reported; one that
 * finds the file deleted elsewhere drops the edit and reports its text.
 *
 * Creating, deleting, Save version, and the import of old captures are
 * actions. A delete runs once the capture's edits landed. Closing fences
 * new input, then waits for the edits held and every action. Quitting
 * Epicenter asks nothing (ADR-0542). Saves never commit (ADR-0529); a
 * version is recorded only by Save version.
 *
 * Input not committed yet is `$state`: the New capture text, and for each
 * capture its thought typed and not added and its thought being edited
 * (`formOf`). Those stay while the person moves between captures.
 */

import {
	CAPTURES_TABLE,
	type CaptureFields,
	captureBody,
	type captureDefinition,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import {
	type CommitOutcome,
	type FileError,
	isStoredRow,
	type RowReadError,
	type RowWriteError,
	rowPath,
	rowStemOf,
	type StoredRow,
	type TableListing,
	type WriteError,
	type WrittenRow,
} from '@epicenter/folder';
import type { OpenedFile } from '@epicenter/folder/file-browser';
import type { FolderContext } from '@epicenter/svelte/folder';
import { ActionError } from '@epicenter/svelte/write-failure';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type CaptureForm, createCaptureForm } from './capture-form.svelte.js';

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
	/**
	 * Whether the file has changes that are in no saved version, as Git
	 * status last checked; `undefined` when the check failed.
	 */
	readonly unversioned: boolean | undefined;
};

/**
 * The opened captures folder, as `getFolder()` answers it. Its own
 * `definition` is `captureDefinition` for Capture's own folder, and the
 * folder's declaration for any other folder Epicenter hands it.
 */
export type CaptureFolder = FolderContext<typeof captureDefinition>;

/**
 * Cache identity for the app's own actions. Every read is keyed under the
 * folder (`folderOptions`).
 */
export const capturesKeys = defineKeys({
	create: ['captures', 'create'],
	saveVersion: ['captures', 'save-version'],
});

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

export function createCaptures(context: CaptureFolder) {
	const { folder, queries, queryClient, edits } = context;
	const pathOf = (stem: string) => rowPath(CAPTURES_TABLE, stem);
	const { defineMutation } = createQueryFactories(queryClient);
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));

	/** What the detail shows. */
	let opened = $state.raw<Opened | undefined>();
	/** The New capture text, typed and not added. */
	let newCapture = $state('');
	/** Each capture's input not committed yet, kept while the person moves between captures. */
	const forms = new SvelteMap<string, CaptureForm>();

	/** Why no edit or action starts now, if one does not. */
	const refused = () => edits.refusal();

	const listKey = queries.captures.list.queryKey();
	const rowsData = () => queryClient.getQueryData<CaptureListing>(listKey);
	/** The text of `path` as the cache holds it, when it opens as text. */
	const shownText = (path: string) => {
		const opened = queryClient.getQueryData<OpenedFile>(
			queries.files.text.queryKey(path),
		);
		return opened?.kind === 'text' ? opened.text : undefined;
	};

	/** The row the cache holds for `stem`, if it reads as a row. */
	function rowOf(stem: string): StoredRow<CaptureFields> | undefined {
		const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** The input not committed yet, and the edit, for the capture at `stem`. */
	function formOf(stem: string): CaptureForm {
		const existing = forms.get(stem);
		if (existing !== undefined) return existing;
		const path = pathOf(stem);
		const form = createCaptureForm({
			row: () => rowOf(stem),
			draft: edits.body('captures', stem),
			locked: () => edits.locked(path),
		});
		forms.set(stem, form);
		return form;
	}

	/**
	 * Replace the text of `path`, as the change from the text the view showed
	 * when typing started; it is written after a pause, or at `saveText`.
	 * Refused while closing, while the file is being deleted, and when the
	 * file is not open as text.
	 */
	function editText(path: string, text: string): boolean {
		const draft = edits.text(path);
		// The first change starts from the file shown; later ones keep theirs.
		if (draft.typed === undefined && shownText(path) === undefined)
			return false;
		return draft.change(text);
	}

	/** How many captures hold a thought typed and not added, or a changed thought edit. */
	const unsentForms = () =>
		[...forms.values()].filter((form) => form.unsent).length;

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
			await edits.text(path).save();
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
		if (as === 'text' && edits.text(path).typed === undefined)
			queryClient.removeQueries({
				queryKey: queries.files.text.queryKey(path),
				exact: true,
			});
		opened = { stem, mode: as };
	}

	return {
		folder,
		/** The folder's query layer: every read the views show is keyed under it. */
		queries,
		queryClient,
		/** The folder's edit layer: every draft and write. */
		edits,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** Closing refuses input and actions. */
		get fenced() {
			return edits.fenced;
		},
		/** Whether a save of a capture or a write of a file's text is running or waits, read reactively. */
		get saving() {
			return edits.writing();
		},
		/** Whether `path` takes no edit now: closing, or it is being deleted; read reactively. */
		isDeleting: (path: string) => edits.locked(path),
		/** Whether a browser reload now could lose anything: an edit or action running, or text not saved or added. */
		get unsettled() {
			return edits.busy || newCapture !== '' || unsentForms() > 0;
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The capture listing, narrowed by `select` for one view. */
		rowsQuery<TData = CaptureListing>(
			select?: (listing: CaptureListing) => TData,
		) {
			return { ...queries.captures.list.queryOptions(), select };
		},
		/** The text typed for `path` and not written yet, read reactively. */
		typedText: (path: string) => edits.text(path).typed,

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
		/** Write the text typed for `path`; resolves once no write of it runs. */
		saveText: (path: string) => edits.text(path).save(),
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
				Result<WrittenRow<CaptureFields>, RowWriteError | ActionError>
			> => {
				const why = refused();
				if (why !== undefined) return ActionError.NotStarted({ reason: why });
				// Blank text is refused and stays in the form: only the person clears it.
				if (text.trim() === '')
					return ActionError.NotStarted({ reason: 'Write something first.' });
				const now = new Date();
				const { body } = composeBody(text);
				return edits.writes.tables.captures.create(
					{
						fields: {
							capturedAt: now.toISOString() as CaptureFields['capturedAt'],
						},
						body,
					},
					{ stem: newStem(now) },
				);
			},
			onSuccess: (created, text) => {
				if (newCapture === text) newCapture = '';
				// The file written does not read as a row: the listing says why.
				if (!isStoredRow(created)) return;
				const stem = rowStemOf(CAPTURES_TABLE, created.path);
				// Text that does not read as text and thoughts opens as text.
				if (stem !== undefined) void open(stem, 'capture');
			},
		}),
		/**
		 * What deleting the capture at `stem` would remove, for the person to
		 * confirm, and whether its latest changes are in no saved version.
		 */
		async deletionFor(
			stem: string,
		): Promise<Result<Deletion, FileError | ActionError>> {
			const why = refused();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			const path = pathOf(stem);
			const { error } = await folder.files.read(path);
			if (error !== null) return Err(error);
			const status = await folder.git.status().then(
				(observed) => observed.data ?? undefined,
				() => undefined,
			);
			const body = forms.get(stem)?.body ?? rowOf(stem)?.row.body;
			const text =
				body === undefined ? undefined : captureBody.decode(body).data?.text;
			return Ok({
				stem,
				path,
				title: text?.trim().slice(0, 60) ?? '',
				unversioned: status?.changes.some((change) => change.path === path),
			});
		},
		/**
		 * Delete what was confirmed. It runs after the capture's edits held
		 * here are written, so what this window saved last goes with it, and
		 * it deletes whatever another program wrote since: a delete beats
		 * edits that never saw it (ADR-0576).
		 */
		async delete(
			deletion: Deletion,
		): Promise<Result<undefined, WriteError | ActionError>> {
			const why = refused();
			if (why !== undefined) return ActionError.NotStarted({ reason: why });
			const deleted = await edits.exclusive(deletion.path, () =>
				edits.writes.tables.captures.delete(deletion.stem),
			);
			if (deleted.error !== null) return deleted;
			queryClient.removeQueries({
				queryKey: queries.files.text.queryKey(deletion.path),
				exact: true,
			});
			forms.delete(deletion.stem);
			if (opened?.stem === deletion.stem) opened = undefined;
			return deleted;
		},
		/**
		 * Record a version: commit the saved files (ADR-0529). Edits still
		 * being written land first. Capture has no remote, so nothing is pushed.
		 */
		saveVersion: defineMutation({
			mutationKey: capturesKeys.saveVersion,
			mutationFn: (): Promise<Result<CommitOutcome, ActionError>> =>
				edits.saveVersion(),
		}),
	};
}
