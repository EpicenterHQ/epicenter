/**
 * The Capture product state over its local folder
 * (`openFolder({ tables: captureTables })`), kept in the TanStack Query cache
 * of the folder's context (`getFolder()`).
 *
 * Every view reads the one rows query of the captures table: the timeline,
 * the capture view, and Edit as text, which shows a row's exact source.
 * Changes made outside this page (another tab of Capture) arrive on the
 * folder's change channel, which the context wires to the cache; nothing
 * here reads again on focus. The page's own saves read the rows again once
 * they land.
 *
 * A capture's body is a document, so an edit of it is the row's draft in
 * the folder's edit layer (`edits.row`), which its form types into
 * (`formOf`); an edit of a file's exact text is its text draft (`texts`).
 * Each is held outside the cache, saved a second after the last change, or
 * when the person leaves it, one save at a time as the change from where it
 * started, merged by the folder with whatever was saved since. A failed
 * save keeps the edit on screen with its reason.
 *
 * Creating and deleting are actions. A delete runs once the capture's edits
 * landed. Closing fences new input, then sends the edits held. There is no
 * history, sync, or remote on this path.
 *
 * Input not committed yet is `$state`: the New capture text, and for each
 * capture its thought typed and not added and its thought being edited
 * (`formOf`). Those stay while the person moves between captures.
 */

import {
	CAPTURES_TABLE,
	type CaptureRow,
	captureBody,
	type captureTables,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import type { ReadError, SaveError } from '@epicenter/folder';
import { CLOSING, UNSAVED } from '@epicenter/svelte/edits';
import type { FolderContext } from '@epicenter/svelte/folder';
import { ActionError } from '@epicenter/svelte/write-failure';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type CaptureForm,
	createCaptureForm,
	type StoredCapture,
} from './capture-form.svelte.js';
import { createTextDrafts } from './text-drafts.js';

export type Captures = ReturnType<typeof createCaptures>;

/** The local folder's context, as `<FolderApp>` provides it. */
export type CaptureFolder = FolderContext<typeof captureTables>;

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
};

/** A failure a person is told about. */
export type Failure = SaveError | ReadError | ActionError;

/** The file of the capture `stem`. */
export const capturePath = (stem: string) => `${CAPTURES_TABLE}/${stem}.md`;

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

/** Whether the row's file is not text at all. */
const notText = (row: CaptureRow) =>
	row.issues?.some((issue) => issue.kind === 'not-text') ?? false;

/** Why a row does not read as a capture's frontmatter, one sentence per issue. */
export function problemOf(row: CaptureRow): string {
	return (row.issues ?? [])
		.map((issue) => {
			const at = issue.line === undefined ? '' : `Line ${issue.line}: `;
			const field =
				issue.kind === 'schema' && issue.path.length > 0
					? `${issue.path.join('.')} `
					: '';
			return `${at}${field}${issue.message}.`;
		})
		.join(' ');
}

/**
 * The rows as the timeline shows them: captures newest first, files to
 * repair as text, and files that are not text at all.
 */
export function timelineOf(listed: CaptureRow[]) {
	const rows: TimelineRow[] = [];
	const repairs: Repair[] = [];
	const unreadable: { path: string; message: string }[] = [];
	for (const row of listed) {
		const stem = row.id;
		const path = capturePath(stem);
		if (notText(row)) {
			unreadable.push({ path, message: problemOf(row) });
			continue;
		}
		if (row.issues !== null) {
			repairs.push({ stem, path, problem: problemOf(row) });
			continue;
		}
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

/** What a person is told about a save, read, or delete that failed. */
export function describeFailure(error: Failure): string {
	switch (error.name) {
		case 'StorageFailed':
			return `This device's storage refused it: ${extractErrorMessage(error.cause)}.`;
		case 'NotStarted':
			return error.reason;
		case 'Unparseable':
			return `Its frontmatter cannot be read: ${error.reason}. Edit it as text.`;
		case 'NotText':
			return 'It holds characters a text file cannot, so it was not saved.';
		default:
			return error.message;
	}
}

export function createCaptures(context: CaptureFolder) {
	const { folder, queries, queryClient, edits } = context;
	const rowsOptions = queries.rows('captures');
	const rowsKey = rowsOptions.queryKey;

	/** What the detail shows. */
	let opened = $state.raw<Opened | undefined>();
	/** The New capture text, typed and not added. */
	let newCapture = $state('');
	/** Each capture's input not committed yet, kept while the person moves between captures. */
	const forms = new SvelteMap<string, CaptureForm>();
	/** Captures whose delete is running: their text takes no typing. */
	const deleting = new SvelteSet<string>();

	const draftOf = (stem: string) => edits.row('captures', stem);
	/** Whether `stem` takes no edit now: closing, or it is being deleted. */
	const isLocked = (stem: string) => deleting.has(stem) || draftOf(stem).locked;

	const texts = createTextDrafts({
		files: folder.files,
		queryClient,
		rowsKey,
		refused: (path) =>
			edits.fenced || [...deleting].some((stem) => capturePath(stem) === path),
	});
	context.registerWork({
		get busy() {
			return texts.busy;
		},
		get failed() {
			return texts.failures.length > 0;
		},
		settle: () => texts.settle(),
	});

	const rowsData = () => queryClient.getQueryData<CaptureRow[]>(rowsKey);
	const rowOf = (stem: string) => rowsData()?.find((row) => row.id === stem);
	const storedOf = (stem: string): StoredCapture | undefined => {
		const row = rowOf(stem);
		return row?.issues === null ? row : undefined;
	};

	/** The input not committed yet, and the edit, for the capture at `stem`. */
	function formOf(stem: string): CaptureForm {
		const existing = forms.get(stem);
		if (existing !== undefined) return existing;
		const form = createCaptureForm({
			row: () => storedOf(stem),
			draft: draftOf(stem),
		});
		forms.set(stem, form);
		return form;
	}

	/** How many captures hold a thought typed and not added, or a changed thought edit. */
	const unsentForms = () =>
		[...forms.values()].filter((form) => form.unsent).length;

	/**
	 * Show `stem` as `mode` edits it. A capture that is not a valid one opens
	 * as text. Coming from its text, the text's save lands first and the rows
	 * are read again, so the view shows what was typed there.
	 */
	async function open(stem: string, mode: Mode) {
		if (
			mode === 'capture' &&
			opened?.stem === stem &&
			opened.mode === 'text' &&
			!edits.fenced
		) {
			await texts.text(capturePath(stem)).save();
			await queryClient.refetchQueries({ queryKey: rowsKey, exact: true });
		}
		let as = mode;
		if (mode === 'capture') {
			const row = rowOf(stem);
			if (
				row !== undefined &&
				(row.issues !== null || captureBody.decode(row.body).error !== null)
			)
				as = 'text';
		}
		opened = { stem, mode: as };
	}

	return {
		folder,
		queryClient,
		/** The text drafts of files edited as text. */
		texts,
		/** Closing refuses input and actions. */
		get fenced() {
			return edits.fenced;
		},
		/** Whether `stem` takes no edit now: closing, or it is being deleted; read reactively. */
		isLocked,
		/** Whether the cache holds a file for `stem`. */
		isStored: (stem: string) => rowOf(stem) !== undefined,
		/** Whether a reload now could lose anything: an edit or save running or held, or text not added. */
		get unsettled() {
			return (
				context.busy || texts.busy || newCapture !== '' || unsentForms() > 0
			);
		},
		/** What the header says about saving, read reactively. */
		get saveLabel(): 'Saved' | 'Saving…' | 'Not saved' | 'A save failed' {
			if (context.saveState === 'failed' || texts.failures.length > 0)
				return 'Not saved';
			if (context.saveState === 'saving' || texts.busy) return 'Saving…';
			if (context.saveState === 'recent-failure') return 'A save failed';
			return 'Saved';
		},
		/** Every capture whose last save failed, with why. */
		get failures(): { stem: string; path: string; reason: string }[] {
			const byStem = new Map<
				string,
				{ stem: string; path: string; reason: string }
			>();
			for (const { id, error } of edits.failures)
				byStem.set(id, {
					stem: id,
					path: capturePath(id),
					reason: error === undefined ? '' : describeFailure(error),
				});
			for (const { path, error } of texts.failures) {
				const stem = path.slice(CAPTURES_TABLE.length + 1, -'.md'.length);
				byStem.set(stem, { stem, path, reason: describeFailure(error) });
			}
			return [...byStem.values()].sort(byPath);
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The rows of the captures table, narrowed by `select` for one view. */
		rowsQuery<TData = CaptureRow[]>(select?: (rows: CaptureRow[]) => TData) {
			return { ...rowsOptions, select };
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

		formOf,

		// ------------------------------------------------------------------
		// Actions
		// ------------------------------------------------------------------

		get newCapture() {
			return newCapture;
		},
		inputNewCapture(value: string) {
			if (!edits.fenced) newCapture = value;
		},
		/**
		 * Save `text` as a new capture file and open it. The New capture text
		 * stays in the form when this fails.
		 */
		create(
			text: string,
		): Promise<Result<{ stem: string }, SaveError | ActionError>> {
			if (edits.fenced)
				return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
			return context.run(async () => {
				if (edits.fenced) return ActionError.NotStarted({ reason: CLOSING });
				// Blank text is refused and stays in the form: only the person clears it.
				if (text.trim() === '')
					return ActionError.NotStarted({ reason: 'Write something first.' });
				const now = new Date();
				const stem = newStem(now);
				const { body } = composeBody(text);
				const saved = await folder.tables.captures.set(stem, null, {
					fields: { capturedAt: now.toISOString() },
					body,
				});
				if (saved.error !== null) return saved;
				// Listed before it opens, so the view never says it is gone.
				await queryClient.invalidateQueries({ queryKey: rowsKey });
				if (newCapture === text) newCapture = '';
				// Text that does not read as text and thoughts opens as text.
				await open(stem, 'capture');
				return Ok({ stem });
			});
		},
		/** What deleting the capture at `stem` would remove, for the person to confirm. */
		deletionFor(stem: string): Deletion {
			const body = forms.get(stem)?.body ?? rowOf(stem)?.body;
			const text =
				body === undefined ? undefined : captureBody.decode(body).data?.text;
			return {
				stem,
				path: capturePath(stem),
				title: text?.trim().slice(0, 60) ?? '',
			};
		},
		/**
		 * Delete what was confirmed. It runs after the capture's edits held
		 * here are saved, and deletes the file as it is stored then. A file
		 * changed in that moment, here or in another tab, is kept, and the
		 * result says so (`deleted: false`).
		 */
		delete(deletion: Deletion): Promise<Result<{ deleted: boolean }, Failure>> {
			if (edits.fenced)
				return Promise.resolve(ActionError.NotStarted({ reason: CLOSING }));
			return context.run(async () => {
				if (edits.fenced) return ActionError.NotStarted({ reason: CLOSING });
				const { stem, path } = deletion;
				if (deleting.has(stem))
					return ActionError.NotStarted({
						reason: 'This capture is being deleted.',
					});
				deleting.add(stem);
				try {
					// Text typed as text lands first, so the delete sees it.
					if (texts.held(path)) {
						await texts.text(path).save();
						if (texts.held(path))
							return ActionError.NotStarted({ reason: UNSAVED });
					}
					const deleted = await edits.delete('captures', stem);
					if (deleted.error !== null) return deleted;
					if (deleted.data.deleted || rowOf(stem) === undefined) {
						forms.delete(stem);
						if (opened?.stem === stem) opened = undefined;
					}
					return deleted;
				} finally {
					deleting.delete(stem);
				}
			});
		},
	};
}
