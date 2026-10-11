/**
 * The files open for editing in this window, one draft per path, each in its
 * own edit session (`@epicenter/svelte/edit-session`).
 *
 * A recording, transcript, or transformation that reads as a row opens as a
 * row session over its fields and body. A row file whose text is not a valid
 * row, a row the person chose to edit as text, and any other text file open
 * as a text session over the exact text. Audio and other files that are not
 * text open as what they are, with nothing to save.
 *
 * Several drafts can be open at once: the selected recording with its
 * transcripts beside it, and the selected transformation. Each path is its
 * own slot of `@epicenter/svelte/open-item`, keyed by the path and opened as
 * a row or as text. The library decides which are open; leaving a draft
 * waits for its saves and releases its session, a load that answers after
 * its draft was left is released, and a draft whose save failed or
 * conflicted is left only when the person discards that session's draft.
 */
import {
	type FileTable,
	rowPath,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';
import {
	createEditSession,
	createRowSession,
	createTextSession,
	type RowSession,
	rowSource,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { createOpenItems } from '@epicenter/svelte/open-item';
import { audioMimeTypeOf } from './audio-format.js';
import {
	RECORDINGS,
	type RecordingFields,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
} from './definition.js';
import { readTextFile } from './files.js';
import type { WhisperingFolder } from './workspace/types.js';

/** The tables whose rows this window edits. */
export type RowTable =
	| typeof RECORDINGS
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATIONS;

/** One open file, as its view shows it. */
export type Draft =
	| { readonly kind: 'loading'; readonly path: string }
	| Loaded;

/** What a file opens as once read. */
type Loaded =
	| {
			readonly kind: 'row';
			readonly table: typeof RECORDINGS;
			readonly session: RowSession<RecordingFields>;
	  }
	| {
			readonly kind: 'row';
			readonly table: typeof TRANSCRIPTIONS;
			readonly session: RowSession<TranscriptionFields>;
	  }
	| {
			readonly kind: 'row';
			readonly table: typeof TRANSFORMATIONS;
			readonly session: RowSession<TransformationFields>;
	  }
	/** Exact text. `table` names the row table when the file is one of its rows. */
	| {
			readonly kind: 'text';
			readonly table: RowTable | undefined;
			readonly session: TextSession;
	  }
	| { readonly kind: 'failed'; readonly path: string; readonly message: string }
	| {
			readonly kind: 'audio' | 'binary' | 'tooLarge';
			readonly path: string;
			readonly size: number;
	  };

export type DraftSession = Extract<Draft, { session: unknown }>['session'];

/** How a row file opens: as fields when its text reads as a row, or as text. */
export type OpenAs = 'row' | 'text';

/** What a slot shows: the file at `path`, opened `as`. */
type DraftKey = { readonly path: string; readonly as: OpenAs };

/** The row table a path is a row of, if it is one this window edits. */
export function rowTableOf(path: string): RowTable | undefined {
	for (const table of [RECORDINGS, TRANSCRIPTIONS, TRANSFORMATIONS] as const)
		if (rowStemOf(table, path) !== undefined) return table;
	return undefined;
}

export function sessionOf(draft: Draft | undefined): DraftSession | undefined {
	return draft !== undefined && 'session' in draft ? draft.session : undefined;
}

function pathOf(draft: Draft): string {
	return 'session' in draft ? draft.session.path : draft.path;
}

export function createDrafts(
	folder: WhisperingFolder,
	{
		locked,
		sizeOf,
	}: {
		/** Whether every session refuses input now, as while the app decides to close. */
		locked: () => boolean;
		/** A listed file's size, for a file that opens as details. */
		sizeOf: (path: string) => number;
	},
) {
	/** Read one row: a row session when its text reads as a row, else its text. */
	async function readRow<TFields>(
		rows: FileTable<TFields>,
		table: RowTable,
		stem: string,
		asRow: (stored: StoredRow<TFields>) => Loaded,
	): Promise<Loaded> {
		const path = rowPath(table, stem);
		const { data: stored, error } = await rows.get(stem);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				table,
				session: createTextSession(folder.files, error, { locked }),
			};
		if (error !== null) return { kind: 'failed', path, message: error.message };
		if (stored === undefined)
			return { kind: 'failed', path, message: `${path} is not in the folder.` };
		return asRow(stored);
	}

	/** Read `path` the way `as` opens it. */
	async function load({ path, as }: DraftKey): Promise<Loaded> {
		const table = rowTableOf(path);
		const stem = table && rowStemOf(table, path);
		if (stem !== undefined && as === 'row')
			switch (table) {
				case RECORDINGS:
					return readRow(folder.tables.recordings, table, stem, (stored) => ({
						kind: 'row',
						table,
						// A recording deleted elsewhere is never restored: its audio
						// may be gone too, so its review can only leave it deleted.
						session: createEditSession(
							{
								...rowSource(folder.tables.recordings),
								merge: (path, versions) =>
									folder.tables.recordings.merge(path, versions, {
										restore: false,
									}),
							},
							{ file: stored, value: stored.row },
							{ locked },
						),
					}));
				case TRANSCRIPTIONS:
					return readRow(
						folder.tables.transcriptions,
						table,
						stem,
						(stored) => ({
							kind: 'row',
							table,
							session: createRowSession(folder.tables.transcriptions, stored, {
								locked,
							}),
						}),
					);
				case TRANSFORMATIONS:
					return readRow(
						folder.tables.transformations,
						table,
						stem,
						(stored) => ({
							kind: 'row',
							table,
							session: createRowSession(folder.tables.transformations, stored, {
								locked,
							}),
						}),
					);
			}
		if (table === undefined && audioMimeTypeOf(path) !== undefined)
			return { kind: 'audio', path, size: sizeOf(path) };
		const { data: read, error } = await readTextFile(folder.files, path);
		if (error !== null) return { kind: 'failed', path, message: error.message };
		if (read.kind !== 'text') return { ...read, path };
		return {
			kind: 'text',
			table,
			session: createTextSession(folder.files, read.file, { locked }),
		};
	}

	const items = createOpenItems<string, DraftKey, Loaded, DraftSession>({
		load,
		sessionOf,
		// A row whose text is not valid opens as text, and is shown as text
		// until it opens as a row again; a renamed draft follows its session.
		keyOf: (draft, asked) => ({
			path: pathOf(draft),
			as: draft.kind === 'text' ? 'text' : asked.as,
		}),
		sameKey: (a, b) => a.path === b.path && a.as === b.as,
	});

	return {
		...items,
		/** The draft at `path`, loading or open. */
		get(path: string): Draft | undefined {
			const shown = items.slot(path).shown;
			if (shown === undefined) return undefined;
			return shown.status === 'loading'
				? { kind: 'loading', path }
				: shown.item;
		},
		/**
		 * Show the file at `path`, keeping a draft already open there. A draft
		 * that failed to open is read again.
		 */
		async show(path: string): Promise<void> {
			const slot = items.slot(path);
			const shown = slot.shown;
			if (shown === undefined) await slot.open({ path, as: 'row' });
			else if (shown.status === 'open' && shown.item.kind === 'failed')
				await slot.reload();
		},
		/**
		 * Open the file at `path` again as `as`: leave its draft, then read it.
		 * Answers the session, keeping its draft, while its save failed or
		 * conflicted.
		 */
		async reopen(path: string, as: OpenAs): Promise<DraftSession | undefined> {
			const opened = await items.slot(path).open({ path, as });
			return opened.kind === 'unsaved' ? opened.session : undefined;
		},
		/** Drop the draft at `path` now, without waiting for its saves. */
		forget(path: string) {
			items.slot(path).forget();
		},
	};
}

export type Drafts = ReturnType<typeof createDrafts>;
