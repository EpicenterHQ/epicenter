/**
 * The Capture product state over one opened folder, kept in a TanStack Query
 * cache (ADR-0528).
 *
 * Reads are queries: the capture listing (`folder.tables.captures.list()`),
 * which the timeline and the capture view both read, and the exact text of
 * a capture opened as text. They are read when a view opens, when the
 * window regains focus, and after the app's own actions. Nothing follows
 * the folder's change reports.
 *
 * An edit goes straight into the cache: one immutable `map` over the listing
 * changes one capture, and one replacement changes a file's text. Each edit
 * is written by a mutation scoped to its file, so writes to one file run one
 * at a time. A write reads the cache when it runs, so it saves the newest
 * row and is guarded by the newest confirmed `sha256`; a file has at most
 * one write running and one waiting. A write that succeeds moves the guard
 * forward. A write that fails reads the file again, which rolls the edit
 * back, and reports the text that was lost.
 *
 * Every other action is a mutation too: create, delete, Save version, and
 * the import of old captures. Closing fences new input, then waits until
 * nothing is mutating. Quitting Epicenter asks nothing (ADR-0542). Saves never commit (ADR-0529); a version
 * is recorded only by Save version.
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
	type ImportReport,
	type LegacyBundle,
	runLegacyImport,
} from '@epicenter/capture/legacy';
import {
	type CommitOutcome,
	type FileCapture,
	type FileError,
	formatRow,
	type Row,
	type RowReadError,
	rowPath,
	rowStemOf,
	type SavedRow,
	type StoredRow,
	type TableCreateError,
	type TableError,
	type TableListing,
	type TableSaveError,
} from '@epicenter/folder';
import { type OpenedFile, readTextFile } from '@epicenter/folder/file-browser';
import { createSaveBases } from '@epicenter/folder/query';
import type {
	MutationFilters,
	MutationOptions,
	QueryClient,
} from '@tanstack/svelte-query';
import { createSubscriber, SvelteMap } from 'svelte/reactivity';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import {
	createQueryFactories,
	defineKeys,
	resultMutationOptions,
	resultQueryOptions,
} from 'wellcrafted/query';
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

/** A write that failed and was rolled back to the file. */
export type WriteFailure = {
	readonly path: string;
	readonly error: TableError | FileError;
	/** The text that was on screen and is not in the file. */
	readonly lost: string;
};

/** Why an action did not start, or why an import failed. */
export const CapturesError = defineErrors({
	NotStarted: ({ reason }: { reason: string }) => ({ message: reason, reason }),
	ImportFailed: ({ cause }: { cause: unknown }) => ({
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	}),
});
export type CapturesError = InferErrors<typeof CapturesError>;

const CLOSING = 'Capture is closing, so nothing was changed.';

/** Text larger than this opens as file details instead of in the editor. */
const EDITABLE_TEXT_LIMIT = 1024 * 1024;

/** Cache identity for every query and mutation the app runs. */
export const capturesKeys = defineKeys({
	/** Every query the app keeps; read again after the last write settles. */
	all: ['captures'],
	rows: ['captures', 'rows'],
	text: (path: string) => ['captures', 'text', path] as const,
	/** Every write of a capture or a file's text. */
	writes: ['captures', 'write'],
	write: (path: string) => ['captures', 'write', 'row', path] as const,
	writeText: (path: string) => ['captures', 'write', 'text', path] as const,
	remove: (path: string) => ['captures', 'remove', path] as const,
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

/**
 * Resolves once nothing matching `filters` is mutating. It watches the
 * mutation cache, so a mutation that starts meanwhile is waited for too.
 */
export function whenIdle(
	queryClient: QueryClient,
	filters?: MutationFilters,
): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating(filters) > 0) return;
			unsubscribe();
			resolve();
		}
		check();
	});
}

export function createCaptures(
	host: Pick<CaptureHost, 'folder' | 'location'>,
	queryClient: QueryClient,
	{
		onWriteFailed = () => {},
	}: {
		/** A write failed and was rolled back; the app tells the person. */
		onWriteFailed?: (failure: WriteFailure) => void;
	} = {},
) {
	const { folder } = host;
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
	/** Each capture's input not committed yet, kept while the person moves between captures. */
	const forms = new SvelteMap<string, CaptureForm>();
	let closing: Promise<void> | undefined;
	let closed = $state(false);

	/** Why no edit or action starts now, if one does not. */
	function refused(): string | undefined {
		return closed ? CLOSING : undefined;
	}

	// Every file write is local: nothing waits for a network, and nothing retries.
	queryClient.setQueryDefaults(capturesKeys.all, {
		networkMode: 'always',
		// Nothing goes stale on its own: a view that mounts shows what the cache
		// holds, and reads happen only when asked for, never while a write runs.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: () => (writing() ? false : 'always'),
	});
	queryClient.setMutationDefaults(capturesKeys.all, {
		networkMode: 'always',
		retry: false,
	});

	/** Whether a write of a capture or a file's text is running or waiting. */
	const writing = () =>
		queryClient.isMutating({ mutationKey: capturesKeys.writes }) > 0;

	/** Resolves once no write is running or waiting. */
	const writesSettled = () =>
		whenIdle(queryClient, { mutationKey: capturesKeys.writes });

	const rowsData = () =>
		queryClient.getQueryData<CaptureListing>(capturesKeys.rows);
	const textData = (path: string) =>
		queryClient.getQueryData<OpenedFile>(capturesKeys.text(path));

	/** The row each cached version held, which a save merges from. */
	const bases = createSaveBases<CaptureFields>();

	/** The row the cache holds for `stem`, if it reads as a row. */
	function rowOf(stem: string): StoredRow<CaptureFields> | undefined {
		const result = rowsData()?.find((entry) => entry.stem === stem)?.result;
		return result?.error === null ? result.data : undefined;
	}

	/** Change the row at `stem` in the cache: one immutable `map` over the listing. */
	function mapRow(
		stem: string,
		change: (stored: StoredRow<CaptureFields>) => StoredRow<CaptureFields>,
	): boolean {
		let changed = false;
		queryClient.setQueryData<CaptureListing>(capturesKeys.rows, (entries) =>
			entries?.map((entry) => {
				if (entry.stem !== stem || entry.result.error !== null) return entry;
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
		queryClient.setQueryData<OpenedFile>(capturesKeys.text(path), (file) => {
			if (file?.kind !== 'text') return file;
			changed = true;
			return { kind: 'text', file: change(file.file) };
		});
		return changed;
	}

	/** Whether a delete of `path` is running or waiting, which pauses its edits. */
	const removing = (path: string) =>
		queryClient.isMutating({
			mutationKey: capturesKeys.remove(path),
			exact: true,
		}) > 0;

	/** How many writes of the kind `mutationKey` names are running or waiting. */
	const queued = (mutationKey: readonly unknown[]) =>
		queryClient.isMutating({ mutationKey, exact: true });

	/** The text a person loses with a capture that could not be written. */
	function rowText(row: Row<CaptureFields>) {
		return formatRow(captureDefinition.tables.captures, row).data ?? row.body;
	}

	/**
	 * After a failed write, the cache takes the row as the file holds it
	 * now. TanStack awaits this before the next write of the file runs, so
	 * that write saves the file's own bytes instead of the failed edit.
	 */
	async function reloadRow(stem: string) {
		await queryClient.cancelQueries({
			queryKey: capturesKeys.rows,
			exact: true,
		});
		const { data: stored, error } = await table.get(stem);
		queryClient.setQueryData<CaptureListing>(capturesKeys.rows, (entries) =>
			entries?.flatMap((entry) => {
				if (entry.stem !== stem) return [entry];
				if (error !== null) return [{ stem, result: Err(error) }];
				return stored === undefined ? [] : [{ stem, result: Ok(stored) }];
			}),
		);
	}

	/** After a failed write of a file's text, the cache takes the file as it is now. */
	async function reloadText(path: string) {
		const key = capturesKeys.text(path);
		await queryClient.cancelQueries({ queryKey: key, exact: true });
		const read = await readTextFile(folder.files, path, EDITABLE_TEXT_LIMIT);
		if (read.error === null) queryClient.setQueryData(key, read.data);
		else await queryClient.invalidateQueries({ queryKey: key, exact: true });
	}

	/**
	 * Read again what an action may have changed. While a write runs nothing
	 * is read: the last write to settle reads everything again.
	 */
	const invalidate = (queryKey: readonly unknown[] = capturesKeys.all) =>
		writing() ? Promise.resolve() : queryClient.invalidateQueries({ queryKey });

	/** After a write settles: once it is the last one, everything is read again. */
	const afterWrite = () =>
		queryClient.isMutating({ mutationKey: capturesKeys.writes }) <= 1
			? queryClient.invalidateQueries({ queryKey: capturesKeys.all })
			: undefined;

	/**
	 * The write of one capture. It saves the row the cache holds when it
	 * runs over the version the cache last confirmed, from the row that
	 * version held; a file changed elsewhere since is merged with it.
	 */
	function rowWrite(stem: string) {
		const path = pathOf(stem);
		return resultMutationOptions({
			mutationKey: capturesKeys.write(path),
			// Row and text writes, and the delete, of one file share its queue.
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<SavedRow<CaptureFields> | undefined, TableSaveError>
			> => {
				const stored = rowOf(stem);
				if (stored === undefined) return Ok(undefined);
				const saved = await table.save(bases.baseOf(stem, stored), stored.row);
				if (saved.error === null) bases.saved(stem, stored.row, saved.data);
				return saved;
			},
			onSuccess: (saved) => {
				if (saved === undefined) return;
				// TanStack awaits this before the next write in the scope runs.
				mapRow(stem, (stored) => ({
					...stored,
					path: saved.stored.path,
					sha256: saved.stored.sha256,
				}));
				// The same file's text, if a view read it, is read again.
				void invalidate(capturesKeys.text(path));
			},
			onError: async (error) => {
				const lost = rowOf(stem);
				await reloadRow(stem);
				onWriteFailed({
					path,
					error,
					lost: lost === undefined ? '' : rowText(lost.row),
				});
			},
			onSettled: afterWrite,
		});
	}

	/** The write of one file's text, as `rowWrite` is for a capture. */
	function textWrite(path: string) {
		return resultMutationOptions({
			mutationKey: capturesKeys.writeText(path),
			scope: { id: path },
			mutationFn: async (): Promise<
				Result<FileCapture | undefined, FileError>
			> => {
				const file = textData(path);
				if (file?.kind !== 'text') return Ok(undefined);
				return folder.files.replace(file.file, file.file.text);
			},
			onSuccess: (saved) => {
				if (saved === undefined) return;
				mapText(path, (file) => ({ ...file, sha256: saved.sha256 }));
				// A capture file's text decides whether it reads as a capture.
				void invalidate(capturesKeys.rows);
			},
			onError: async (error) => {
				const lost = textData(path);
				await reloadText(path);
				onWriteFailed({
					path,
					error,
					lost: lost?.kind === 'text' ? lost.file.text : '',
				});
			},
			onSettled: afterWrite,
		});
	}

	/** Queue the write `options` describes; a failure is reported by its own `onError`. */
	function queue<TData, TError>(options: MutationOptions<TData, TError>) {
		void queryClient
			.getMutationCache()
			.build(queryClient, options)
			.execute(undefined)
			.catch(() => undefined);
	}

	/**
	 * Change the capture at `stem` in the cache, and queue its write unless
	 * one already waits: the waiting write saves whatever the cache holds
	 * when it runs. Refused, changing nothing, while Epicenter asks to leave,
	 * while closing, and while the capture is being deleted. Answers whether
	 * the cache changed.
	 */
	function edit(
		stem: string,
		change: (row: Row<CaptureFields>) => Row<CaptureFields>,
	): boolean {
		const path = pathOf(stem);
		if (refused() !== undefined || removing(path)) return false;
		// A read still running could replace this edit when it lands.
		void queryClient.cancelQueries({
			queryKey: capturesKeys.rows,
			exact: true,
		});
		const changed = mapRow(stem, (stored) => {
			bases.editing(stem, stored);
			return { ...stored, row: change(stored.row) };
		});
		if (!changed) return false;
		if (queued(capturesKeys.write(path)) < 2) queue(rowWrite(stem));
		return true;
	}

	/** Replace the text of `path` in the cache and queue its write, as `edit` does. */
	function editText(path: string, text: string): boolean {
		if (refused() !== undefined || removing(path)) return false;
		void queryClient.cancelQueries({
			queryKey: capturesKeys.text(path),
			exact: true,
		});
		const changed = mapText(path, (file) => ({ ...file, text }));
		if (!changed) return false;
		if (queued(capturesKeys.writeText(path)) < 2) queue(textWrite(path));
		return true;
	}

	/** The input not committed yet for the capture at `stem`. */
	function formOf(stem: string): CaptureForm {
		let form = forms.get(stem);
		if (form === undefined) {
			form = createCaptureForm({
				body: () => rowOf(stem)?.row.body,
				setBody: (body) => edit(stem, (row) => ({ ...row, body })),
				locked: () => refused() !== undefined || removing(pathOf(stem)),
			});
			forms.set(stem, form);
		}
		return form;
	}

	/** How many captures hold a thought typed and not added, or a changed thought edit. */
	const unsentForms = () =>
		[...forms.values()].filter((form) => form.unsent).length;

	/**
	 * The capture a delete of `path` acts on, read when it runs: the newest
	 * hash the cache confirmed for what the app edits, if it holds one.
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
	 * capture is read again, so the view shows what was typed there.
	 */
	async function open(stem: string, mode: Mode) {
		const path = pathOf(stem);
		if (
			mode === 'capture' &&
			opened?.stem === stem &&
			opened.mode === 'text' &&
			refused() === undefined
		) {
			await whenIdle(queryClient, {
				mutationKey: capturesKeys.writeText(path),
				exact: true,
			});
			await reloadRow(stem);
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
		// Text opened before is read again, unless a write of it is still landing.
		if (as === 'text' && queued(capturesKeys.writeText(path)) === 0)
			queryClient.removeQueries({
				queryKey: capturesKeys.text(path),
				exact: true,
			});
		opened = { stem, mode: as };
	}

	return {
		location: host.location,
		folder,
		queryClient,
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** Closing refuses input and actions. */
		get fenced() {
			return closed;
		},
		/** How many mutations match `filters`, read reactively. */
		mutating(filters?: MutationFilters) {
			trackMutations();
			return queryClient.isMutating(filters);
		},
		/** Whether a write of a capture or a file's text is running or waiting, read reactively. */
		get saving() {
			trackMutations();
			return writing();
		},
		/** Whether `path` is being deleted, which pauses its edits; read reactively. */
		isRemoving(path: string) {
			trackMutations();
			return removing(path);
		},
		/** Whether a browser reload now could lose anything: an action running, or text not added. */
		get unsettled() {
			trackMutations();
			return (
				queryClient.isMutating() > 0 || newCapture !== '' || unsentForms() > 0
			);
		},

		// ------------------------------------------------------------------
		// Reads
		// ------------------------------------------------------------------

		/** The capture listing, narrowed by `select` for one view. */
		rowsQuery<TData = CaptureListing>(
			select?: (listing: CaptureListing) => TData,
		) {
			return resultQueryOptions({
				queryKey: capturesKeys.rows,
				queryFn: () => table.list(),
				select,
			});
		},
		/** One file's complete text, or its type and size when it is not editable text. */
		textQuery(path: string) {
			return resultQueryOptions({
				queryKey: capturesKeys.text(path),
				queryFn: () => readTextFile(folder.files, path, EDITABLE_TEXT_LIMIT),
			});
		},

		// ------------------------------------------------------------------
		// What the detail shows
		// ------------------------------------------------------------------

		/** The open capture, or `undefined` for the timeline. */
		get opened() {
			return opened;
		},
		open,
		/** Back to the timeline. Writes go on landing; nothing waits or asks. */
		leave() {
			opened = undefined;
		},

		// ------------------------------------------------------------------
		// Edits
		// ------------------------------------------------------------------

		edit,
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
			mutationKey: ['captures', 'create'],
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
					capturesKeys.rows,
					(entries) => entries && [...entries, { stem, result: Ok(created) }],
				);
				// Text that does not read as text and thoughts opens as text.
				void open(stem, 'capture');
			},
			onSettled: () => invalidate(capturesKeys.rows),
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
			const body = rowOf(stem)?.row.body;
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
		 * Delete what was confirmed. It runs after the file's queued writes,
		 * so it removes what this window saved last; a file another program
		 * changed since is refused, and everything is read again.
		 */
		remove(deletion: Deletion) {
			return defineMutation({
				mutationKey: capturesKeys.remove(deletion.path),
				scope: { id: deletion.path },
				mutationFn: async (): Promise<
					Result<undefined, FileError | TableError | CapturesError>
				> => {
					const why = refused();
					if (why !== undefined)
						return CapturesError.NotStarted({ reason: why });
					return table.delete(heldCapture(deletion.stem) ?? deletion.capture);
				},
				onSuccess: () => {
					queryClient.setQueryData<CaptureListing>(
						capturesKeys.rows,
						(entries) =>
							entries?.filter((entry) => entry.stem !== deletion.stem),
					);
					queryClient.removeQueries({
						queryKey: capturesKeys.text(deletion.path),
						exact: true,
					});
					forms.delete(deletion.stem);
					if (opened?.stem === deletion.stem) opened = undefined;
				},
				onSettled: () => invalidate(),
			})();
		},
		/**
		 * Record a version: commit the saved files (ADR-0529). Writes still
		 * running land first. Capture has no remote, so nothing is pushed.
		 */
		saveVersion: defineMutation({
			mutationKey: ['captures', 'save-version'],
			mutationFn: async (): Promise<Result<CommitOutcome, CapturesError>> => {
				const why = refused();
				if (why !== undefined) return CapturesError.NotStarted({ reason: why });
				await writesSettled();
				return Ok(await folder.git.commit());
			},
		}),
		/** Import a whole export, including its report and receipt, then read everything again. */
		importLegacy: defineMutation({
			mutationKey: ['captures', 'import'],
			mutationFn: async (
				bundle: LegacyBundle,
			): Promise<Result<ImportReport, CapturesError>> => {
				const why = refused();
				if (why !== undefined) return CapturesError.NotStarted({ reason: why });
				try {
					return Ok(await runLegacyImport(folder.files, bundle));
				} catch (cause) {
					return CapturesError.ImportFailed({ cause });
				}
			},
			onSettled: () => invalidate(),
		}),

		// ------------------------------------------------------------------
		// Closing
		// ------------------------------------------------------------------

		/**
		 * Fence new input, then wait until nothing is mutating before the page
		 * releases its folder. Every call answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closed = true;
			closing = (async () => {
				await whenIdle(queryClient);
				await queryClient.cancelQueries({ queryKey: capturesKeys.all });
			})();
			return closing;
		},
	};
}
