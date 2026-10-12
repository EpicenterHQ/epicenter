/**
 * The Capture product state over one opened folder.
 *
 * The timeline is the last listing of `captures/*.md`. It is read when the
 * page opens, after each of the app's own actions, and when the person
 * returns to the window; the latest listing wins. It offers the files that
 * read as captures and names the rest, with why, for repair as text.
 *
 * One capture is open at a time, in one edit session
 * (`@epicenter/svelte/edit-session`): as a capture, a row session whose body
 * the capture form edits as text and thoughts; or as text, a text session
 * over the file's exact Markdown, which is how a file that is not a valid
 * capture is repaired. The open-item slot (`@epicenter/svelte/open-item`)
 * owns leaving: it waits for the session's saves, then releases it, and the
 * timeline is listed again. A save that failed or conflicted, or a thought
 * typed and not added, keeps the capture open until the person discards it
 * (`open` and `leave` answer `unsaved` with the session, and the view asks).
 *
 * Returning to the window takes a newer version of the open capture when its
 * session holds nothing unsaved. Otherwise the next save reports the change
 * as a conflict, and the person keeps theirs or reloads.
 */

import {
	CAPTURES_TABLE,
	type CaptureFields,
	captureBody,
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
	type RowReadError,
	rowPath,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';
import { createAdmissions } from '@epicenter/svelte/admissions';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
	textSource,
} from '@epicenter/svelte/edit-session';
import { createOpenItem } from '@epicenter/svelte/open-item';
import { createSubscriber } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
import { type CaptureForm, createCaptureForm } from './capture-form.svelte.js';
import type { CaptureHost } from './platform/types.js';

const log = createLogger('capture');

export type Captures = ReturnType<typeof createCaptures>;

/** How a capture is open: its text and thoughts, or its exact Markdown. */
export type Mode = 'capture' | 'text';

/** Which capture is open, and how. */
type Key = { readonly stem: string; readonly mode: Mode };

/** A capture as its loader built it. */
type Item =
	| {
			readonly kind: 'capture';
			readonly stem: string;
			readonly session: RowSession<CaptureFields>;
			readonly form: CaptureForm;
	  }
	| {
			readonly kind: 'text';
			readonly stem: string;
			readonly session: TextSession;
	  }
	| {
			readonly kind: 'failed';
			readonly stem: string;
			readonly mode: Mode;
			readonly message: string;
	  };

/** The one open capture: what the detail shows. */
export type Opened =
	| { readonly kind: 'loading'; readonly stem: string; readonly mode: Mode }
	| Item;

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

const CLOSING = 'Capture is closing, so nothing was changed.';

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A lost reply leaves the outcome unknown.
 */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
	readonly actualSha256?: string | undefined;
	readonly issues?: readonly { readonly message: string }[];
}): string {
	switch (error.name) {
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer here, so nothing was changed.'
				: 'The file changed elsewhere, so nothing was changed. Check it and try again.';
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`;
		case 'InvalidValues':
			return (error.issues ?? []).map((issue) => issue.message).join(' ');
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

export function createCaptures(host: CaptureHost) {
	const { folder } = host;
	const table = folder.tables.captures;
	const pathOf = (stem: string) => rowPath(CAPTURES_TABLE, stem);

	let timeline = $state.raw<TimelineRow[]>([]);
	let repairs = $state.raw<Repair[]>([]);
	/** Capture files that are not text, or could not be read. */
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	/** Why the folder could not be listed, when it could not. */
	let listProblem = $state<string | undefined>();
	let loaded = $state(false);
	let newCapture = $state('');
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	/** The Epicenter service that served this page has stopped. */
	let serviceStopped = $state(false);
	let closing: Promise<void> | undefined;
	let refreshSequence = 0;
	/** Commands admitted and not finished: `close` waits for them. */
	const { command, quiet, ...admissions } = createAdmissions();

	const locked = () => closing !== undefined;

	/** Why no action starts now, if one does not. */
	function refused(): string | undefined {
		if (closing !== undefined) return CLOSING;
		return undefined;
	}

	/** One listing pass. A pass that a newer one overtook changes nothing. */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const { data: listed, error } = await table.list();
		if (closing !== undefined || sequence !== refreshSequence) return;
		// Keep the previous listing visible; never show an empty one for a failed read.
		if (error !== null) {
			listProblem = error.message;
			return;
		}
		const rows: TimelineRow[] = [];
		const repair: Repair[] = [];
		const others: { path: string; message: string }[] = [];
		for (const { stem, result } of listed) {
			const path = pathOf(stem);
			if (result.error?.name === 'InvalidRow') {
				repair.push({ stem, path, problem: readProblem(result.error) });
				continue;
			}
			if (result.error !== null) {
				others.push({ path, message: readProblem(result.error) });
				continue;
			}
			const { row } = result.data;
			const { data: body, error: refusal } = captureBody.decode(row.body);
			if (refusal !== null) {
				repair.push({ stem, path, problem: refusal.message });
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
		listProblem = undefined;
		loaded = true;
		timeline = rows.sort(newestFirst);
		repairs = repair.sort(byPath);
		unreadable = others.sort(byPath);
	}

	function openRow(stem: string, stored: StoredRow<CaptureFields>): Item {
		const session = createRowSession(table, stored, { locked });
		return { kind: 'capture', stem, session, form: createCaptureForm(session) };
	}

	/** The file's exact text, as a text session. */
	async function loadText(stem: string): Promise<Item> {
		const { data: found, error } = await textSource(folder.files).reread(
			pathOf(stem),
		);
		if (error !== null)
			return { kind: 'failed', stem, mode: 'text', message: error.message };
		if (found.kind === 'gone')
			return {
				kind: 'failed',
				stem,
				mode: 'text',
				message: 'This capture is no longer in the folder.',
			};
		if (found.kind === 'other')
			return {
				kind: 'failed',
				stem,
				mode: 'text',
				message: 'This file is not UTF-8 text, so it cannot be edited here.',
			};
		return {
			kind: 'text',
			stem,
			session: createTextSession(
				folder.files,
				{ ...found.file, text: found.value },
				{ locked },
			),
		};
	}

	/**
	 * Read `stem` the way `mode` opens it. A file that is not a valid capture
	 * opens as text whichever was asked.
	 */
	async function load({ stem, mode }: Key): Promise<Item> {
		if (mode === 'text') return loadText(stem);
		const { data: stored, error } = await table.get(stem);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				stem,
				session: createTextSession(folder.files, error, { locked }),
			};
		if (error !== null)
			return { kind: 'failed', stem, mode, message: readProblem(error) };
		if (stored === undefined)
			return {
				kind: 'failed',
				stem,
				mode,
				message: 'This capture is no longer in the folder.',
			};
		if (captureBody.decode(stored.row.body).error !== null)
			return loadText(stem);
		return openRow(stem, stored);
	}

	/** How an item shows its file; a failed item, as it was asked. */
	const modeOf = (item: Item): Mode =>
		item.kind === 'capture'
			? 'capture'
			: item.kind === 'text'
				? 'text'
				: item.mode;

	/**
	 * The open capture. A thought typed and not added is input outside its
	 * session, so leaving asks about it as it does about a failed save.
	 */
	const slot = createOpenItem({
		load,
		sessionOf: (item: Item) =>
			item.kind === 'failed' ? undefined : item.session,
		// A capture asked for as a capture that opened as text is shown as text,
		// so asking for it as a capture again (once repaired) reads it.
		keyOf: (item, asked): Key => ({ stem: asked.stem, mode: modeOf(item) }),
		sameKey: (a: Key, b: Key) => a.stem === b.stem && a.mode === b.mode,
		holds: (item) => item.kind === 'capture' && item.form.unsent,
		closed: () => closing !== undefined,
	});

	/**
	 * Show `stem` as `mode` edits it. The open capture's saves land first,
	 * and the timeline is read again. Answers `unsaved`, opening nothing,
	 * when the open capture holds something it could not save; the view asks
	 * the person and opens again with `{ discard: session }`.
	 */
	async function open(
		stem: string,
		mode: Mode,
		options?: { discard?: RowSession<CaptureFields> | TextSession },
	) {
		const opening = await slot.open({ stem, mode }, options);
		if (opening.kind === 'done' && opening.left) void refresh();
		return opening;
	}

	return {
		location: host.location,
		/** Captures that read as one, newest first, as last listed. */
		get timeline() {
			return timeline;
		},
		/** Capture files the timeline cannot show, with why; each opens as text. */
		get repairs() {
			return repairs;
		},
		get unreadable() {
			return unreadable;
		},
		get listProblem() {
			return listProblem;
		},
		get loaded() {
			return loaded;
		},
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** The folder's owner closed it: nothing saves from this window again. */
		get folderStopped() {
			trackGit();
			return folder.git.snapshot.closed;
		},
		get serviceStopped() {
			return serviceStopped;
		},
		/** Saving is the folder's and carries on; the page can load nothing more. */
		markServiceStopped() {
			serviceStopped = true;
		},
		/** Closing refuses input and actions. */
		get fenced() {
			return locked();
		},
		/** The open capture, or `undefined`. */
		get opened(): Opened | undefined {
			const shown = slot.shown;
			if (shown?.status === 'loading')
				return { kind: 'loading', stem: shown.key.stem, mode: shown.key.mode };
			return shown?.item;
		},
		/** The open capture has a save running, a draft it could not save, or a thought not added. */
		get unsaved() {
			return slot.unsaved;
		},
		/** How many things leaving now could lose: the open capture, the New capture text, running actions. */
		get unsettled() {
			return (
				(slot.unsaved ? 1 : 0) +
				(newCapture === '' ? 0 : 1) +
				(admissions.busy ? 1 : 0)
			);
		},
		get newCapture() {
			return newCapture;
		},
		inputNewCapture(value: string) {
			if (!locked()) newCapture = value;
		},
		refresh,
		/** Returning to the window: the listing, and a newer version of the open capture when it holds nothing unsaved. */
		async check() {
			if (closing !== undefined) return;
			await Promise.all([refresh(), slot.adopt()]);
		},
		open,
		/** Read the open capture again as it is now, as it was asked to open: Try again after a failed open. */
		reload: () => slot.reload(),
		/** Leave the open capture for the timeline. Answers `unsaved` as `open` does. */
		async leave(options?: {
			discard?: RowSession<CaptureFields> | TextSession;
		}) {
			const left = await slot.leave(options);
			if (left.kind === 'done') await refresh();
			return left;
		},
		/**
		 * Reload theirs for `session`, the open capture's: show the file as it
		 * is now. A file that is gone closes; one the session can no longer
		 * show (a capture whose text is no longer a valid row) opens again as
		 * it reads now. Answers what the person is told, if anything.
		 */
		reloadTheirs: command(
			async (
				session: RowSession<CaptureFields> | TextSession,
			): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const reloaded = await slot.reloadTheirs(session);
				if (reloaded === undefined) return undefined;
				if (reloaded.error !== null) return describeError(reloaded.error);
				await refresh();
				return undefined;
			},
		),
		/** Keep mine for `session`, the open capture's: save the draft over the file, or create it again. */
		keepMine: command(
			async (
				session: RowSession<CaptureFields> | TextSession,
			): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const kept = await slot.keepMine(session);
				if (kept === undefined) return undefined;
				await refresh();
				return kept.error === null ? undefined : describeError(kept.error);
			},
		),

		/**
		 * Save the New capture text as a new file and open it. The text stays
		 * in the form when the save fails. Answers what the person is told.
		 */
		create: command(async (): Promise<string | undefined> => {
			const why = refused();
			if (why !== undefined) return why;
			const text = newCapture;
			// Blank text is refused and stays in the form: only the person clears it.
			if (text.trim() === '') return 'Write something first.';
			const now = new Date();
			const { body } = composeBody(text);
			let created: Awaited<ReturnType<typeof table.create>>;
			for (let attempt = 0; ; attempt++) {
				created = await table.create(
					{
						fields: {
							capturedAt: now.toISOString() as CaptureFields['capturedAt'],
						},
						body,
					},
					{ stem: newStem(now) },
				);
				// Another capture took this name: a new one is tried.
				if (created.error?.name !== 'Exists' || attempt >= 3) break;
			}
			if (created.error !== null)
				return `The capture was not saved: ${describeError(created.error)} Your text is still here.`;
			if (newCapture === text) newCapture = '';
			await refresh();
			const stem = rowStemOf(CAPTURES_TABLE, created.data.path);
			if (stem !== undefined) await open(stem, 'capture');
			return undefined;
		}),

		/**
		 * Delete the open capture, whose session is `session`. The session is
		 * released and its last saves land first, so the delete removes what
		 * this window saved last; a file another program changed since is
		 * refused, and the capture opens again as it is now.
		 */
		remove: command(
			async (
				session: RowSession<CaptureFields> | TextSession,
			): Promise<string | undefined> => {
				const why = refused();
				if (why !== undefined) return why;
				const removed = await slot.removeOpen(session, (file) =>
					table.delete(file),
				);
				if (removed === undefined) return undefined;
				if (removed.error !== null) return describeError(removed.error);
				await refresh();
				return undefined;
			},
		),

		/** Import a whole export, including its report and receipt, then list again. */
		importLegacy: command(
			async (bundle: LegacyBundle): Promise<ImportReport> => {
				const why = refused();
				if (why !== undefined) throw new Error(why);
				try {
					return await runLegacyImport(folder.files, bundle);
				} finally {
					await refresh();
				}
			},
		),
		/** Commit what is saved. Refused, as other actions are, while closing. */
		commit: command(async (): Promise<CommitOutcome> => {
			const why = refused();
			if (why !== undefined) return { status: 'blocked', reason: why };
			return folder.git.commit();
		}),

		/**
		 * Refuse new work, let running actions and the open capture's saves
		 * finish, then let go of the page's folder. A failed save is not sent
		 * again. Every call answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closing = (async () => {
				await quiet();
				const unsaved = await slot.close();
				if (unsaved !== undefined)
					log.warn(
						new Error(
							`Closed with a capture that could not be saved: ${unsaved}`,
						),
					);
				await host.close();
			})();
			return closing;
		},
	};
}
