/**
 * The Capture product state over its local folder
 * (`openFolder({ tables: captureTables })`), kept in the TanStack Query cache
 * of the folder's context (`getFolder()`).
 *
 * The timeline reads the one rows query of the captures table. The capture
 * view and Edit as text show the folder's edit of one capture, as a row
 * (`createRowEdit(folder.tables.captures, stem)`, which its form types into,
 * `formOf`) or as the file's exact text (`createTextEdit(folder.files,
 * path)`). The folder holds each capture as stored and what is typed over
 * it, one kind of input per path, and saves it a second after the last
 * change or when the person leaves it, one save at a time from where it
 * started, merged with whatever was saved since. Changes made outside this
 * page (another tab of Capture) reach the edits and the rows query alike;
 * the shared context also polls what visible views read. A failed save
 * keeps the edit on screen with its reason.
 *
 * Creating and deleting are actions. A delete runs once the capture's edits
 * landed. Closing fences new input, then sends the edits held. There is no
 * history, sync, or remote on this path.
 *
 * A new composition is a capture file with `draft: true`, its raw writing
 * in the body. Add promotes that same file. Only unfinished thought forms
 * remain in page state (`formOf`).
 */

import {
	CAPTURES_TABLE,
	type CaptureRow,
	captureBody,
	captureTables,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import { type ReadError, SaveError } from '@epicenter/folder';
import { documentChange, readDocument } from '@epicenter/folder/documents';
import { ActionError, CLOSING, UNSAVED } from '@epicenter/folder/edits';
import { createRowEdit } from '@epicenter/svelte/edits';
import type { FolderContext } from '@epicenter/svelte/folder';
import { SvelteMap } from 'svelte/reactivity';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { type CaptureForm, createCaptureForm } from './capture-form.svelte.js';

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
	readonly draft: boolean;
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

/** Drafts hold raw writing; only added captures interpret a Thoughts section. */
export function readCaptureBody(row: Extract<CaptureRow, { issues: null }>) {
	if (row.fields.draft === true)
		return Ok({
			draft: true,
			text: row.body,
			thoughts: [] as string[],
			hasOtherContent: false,
		});
	const reading = captureBody.decode(row.body);
	if (reading.error !== null) return reading;
	return Ok({ ...reading.data, draft: false });
}

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
	const drafts: TimelineRow[] = [];
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
		const { data: body, error: refusal } = readCaptureBody(row);
		if (refusal !== null) {
			repairs.push({ stem, path, problem: refusal.message });
			continue;
		}
		(body.draft ? drafts : rows).push({
			stem,
			path,
			capturedAt: instantOf(row.fields.capturedAt),
			preview: excerpt(body.text),
			thoughtCount: body.thoughts.length,
		});
	}
	return {
		rows: rows.sort(newestFirst),
		drafts: drafts.sort(newestFirst),
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
			if (error.reason === UNSAVED)
				return 'Your latest writing is not saved. Use Save again, then try this action again.';
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
	const { folder, queries, queryClient } = context;
	const rowsOptions = queries.rows('captures');
	const rowsKey = rowsOptions.queryKey;

	/** What the detail shows. */
	let opened = $state.raw<Opened | undefined>();
	/** Each capture's input not committed yet, kept while the person moves between captures. */
	const forms = new SvelteMap<string, CaptureForm>();

	/** Whether `stem` takes no edit now: closing, or it is being deleted; read reactively, reading no file. */
	const isLocked = (stem: string) =>
		context.closing || createRowEdit(folder.tables.captures, stem).locked;

	const rowsData = () => queryClient.getQueryData<CaptureRow[]>(rowsKey);
	const rowOf = (stem: string) => rowsData()?.find((row) => row.id === stem);

	/** The input not committed yet, and the folder's edit, for the capture at `stem`. */
	function formOf(stem: string): CaptureForm {
		const existing = forms.get(stem);
		if (existing !== undefined) return existing;
		const form = createCaptureForm(createRowEdit(folder.tables.captures, stem));
		forms.set(stem, form);
		return form;
	}

	/** Show either view of the path's current edit; invalid content stays as text. */
	function open(stem: string, mode: Mode) {
		let as = mode;
		if (mode === 'capture') {
			const row = folder.tables.captures.edit(stem).getRow() ?? rowOf(stem);
			if (
				row !== undefined &&
				(row.issues !== null || readCaptureBody(row).error !== null)
			)
				as = 'text';
		}
		if (opened?.stem !== stem || opened.mode !== as)
			opened = { stem, mode: as };
	}

	return {
		folder,
		queryClient,
		/** Closing refuses input and actions. */
		get fenced() {
			return context.closing;
		},
		/** Whether `stem` takes no edit now: closing, or it is being deleted; read reactively. */
		isLocked,
		/** Whether the cache holds a file for `stem`. */
		isStored: (stem: string) => rowOf(stem) !== undefined,
		/** What the header says about saving, read reactively. */
		get saveLabel(): 'Saved' | 'Saving…' | 'Not saved' | 'A save failed' {
			const { failures, saving, unsaved, storageFailure } = context.getStatus();
			if (failures.length > 0) return 'Not saved';
			if (saving || unsaved.length > 0) return 'Saving…';
			if (storageFailure !== null) return 'A save failed';
			return 'Saved';
		},
		/** Every capture whose last save failed, as fields or as text, with why. */
		get failures(): { stem: string; path: string; reason: string }[] {
			return context
				.getStatus()
				.failures.map(({ path, error }) => ({
					stem: path.slice(CAPTURES_TABLE.length + 1, -'.md'.length),
					path,
					reason: error === undefined ? '' : describeFailure(error),
				}))
				.sort(byPath);
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The rows of the captures table, narrowed by `select` for one view. */
		rowsQuery<TData = CaptureRow[]>(select?: (rows: CaptureRow[]) => TData) {
			return { ...rowsOptions, select };
		},
		/** The file of an open capture's edit, read again while it shows, so outside edits reach it. */
		readQuery: queries.read,

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

		/** Create a durable empty composition before accepting any typing. */
		async create(): Promise<Result<{ stem: string }, SaveError | ActionError>> {
			if (context.closing) return ActionError.NotStarted({ reason: CLOSING });
			const now = new Date();
			const stem = newStem(now);
			const saved = await folder.tables.captures.set(stem, null, {
				fields: { capturedAt: now.toISOString(), draft: true },
				body: '',
			});
			if (saved.error !== null) return saved;
			if (context.closing) return Ok({ stem });
			// Listed before it opens, so the view never says it is gone. A read
			// for this view, joining the one the save's change started.
			await context.refresh([capturePath(stem)]);
			open(stem, 'capture');
			return Ok({ stem });
		},
		/** Save raw input, then promote this same file once. A failed write keeps the raw draft. */
		async add(stem: string): Promise<Result<void, Failure>> {
			const path = capturePath(stem);
			const added = await folder.files
				.edit(path)
				.exclusive(async (file): Promise<Result<void, Failure>> => {
					const read = await file.read();
					if (read.error !== null) return read;
					if (read.data === undefined)
						return ActionError.NotStarted({
							reason: 'This draft is no longer here.',
						});
					const bytes = new Uint8Array(await read.data.content.arrayBuffer());
					const row = readDocument(path, bytes, captureTables.captures);
					if (row.issues !== null)
						return ActionError.NotStarted({
							reason: 'Repair this file as text before adding it.',
						});
					// A previous attempt or another tab already added it. Never append twice.
					if (row.fields.draft !== true) return Ok(undefined);
					if (row.body.trim() === '')
						return ActionError.NotStarted({ reason: 'Write something first.' });
					const changed = documentChange(row, {
						fields: { draft: undefined, capturedAt: new Date().toISOString() },
						body: composeBody(row.body).body,
					});
					if (changed.error !== null)
						return SaveError.Unparseable({ reason: changed.error.reason });
					return file.write(bytes, changed.data.text);
				});
			if (added.error !== null) return added;
			if (added.data.error !== null) return added.data;
			if (!context.closing) {
				await context.refresh([path]);
				open(stem, 'capture');
			}
			return Ok(undefined);
		},
		/** What deleting the capture at `stem` would remove, for the person to confirm. */
		deletionFor(stem: string): Deletion {
			const row = folder.tables.captures.edit(stem).getRow() ?? rowOf(stem);
			const reading =
				row?.issues === null ? readCaptureBody(row).data : undefined;
			return {
				stem,
				path: capturePath(stem),
				title: reading?.text.trim().slice(0, 60) ?? '',
				draft: reading?.draft ?? false,
			};
		},
		/**
		 * Delete what was confirmed. It runs after what is typed into the
		 * capture, as fields or as text, is saved, and deletes the file as it
		 * is stored then. A file changed in that moment, here or in another
		 * tab, is kept, and the result says so (`deleted: false`).
		 */
		async delete(
			deletion: Deletion,
		): Promise<Result<{ deleted: boolean }, Failure>> {
			if (context.closing) return ActionError.NotStarted({ reason: CLOSING });
			const { stem } = deletion;
			const deleted = await folder.tables.captures.edit(stem).delete();
			if (deleted.error !== null) return deleted;
			if (deleted.data.deleted || rowOf(stem) === undefined) {
				forms.delete(stem);
				if (opened?.stem === stem) opened = undefined;
			}
			return deleted;
		},
	};
}
