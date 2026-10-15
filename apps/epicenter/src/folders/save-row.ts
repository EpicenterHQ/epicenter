/**
 * Save one edited row of a data folder's table at once, and settle a save
 * another writer overtook.
 *
 * The Folders window keeps no drafts: it is not a departure participant, so
 * every edit is saved as it is made (`table.replace`, guarded by the bytes
 * the row was read from). When another window saved the row first, the save
 * is `Conflict`. Then the current file is read and merged with `mergeRow`:
 * base is the row as this window read it, ours the edited row, theirs the
 * current file. Fields only one side changed keep that side's value. Where
 * both sides changed a field, or the same body lines, ours wins, and the
 * outcome names each value it replaced so the view can say so. The merged row
 * is saved against the current file's bytes, and that repeats a bounded
 * number of times before the save gives up and the view reads the row again.
 *
 * This module has no DOM and no Svelte, so it runs under `bun test` against a
 * folder opened by `@epicenter/folder/bun`.
 */

import {
	type AnyRow,
	type FileTable,
	formatRow,
	mergeRow,
	type PreparedFolderTable,
	type RowMerge,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';

/** A table of a folder opened by its own declaration: rows are untyped. */
export type AnyTable = FileTable<Record<string, unknown>>;

/** A row as one read captured it. */
export type StoredAnyRow = StoredRow<Record<string, unknown>>;

/** A value of the other writer's that this save replaced, because both changed it. */
export type Replaced =
	| { readonly kind: 'field'; readonly field: string; readonly theirs: unknown }
	| { readonly kind: 'body'; readonly theirs: string };

export type SaveOutcome =
	/** Saved over the bytes the row was read from. */
	| { readonly kind: 'saved'; readonly stored: StoredAnyRow }
	/**
	 * Another writer changed the row first; their changes and this edit were
	 * merged and saved. `replaced` lists what of theirs this edit overrode.
	 */
	| {
			readonly kind: 'merged';
			readonly stored: StoredAnyRow;
			readonly replaced: readonly Replaced[];
	  }
	/** Nothing was saved; `message` says why, for a person. */
	| { readonly kind: 'failed'; readonly message: string };

/** How many times a save merges with a newer file before it gives up. */
export const MERGE_ATTEMPTS = 3;

/**
 * Save `edited` over `captured`, merging with another writer's newer file
 * when the save is overtaken. `table` is the folder's file table and
 * `prepared` its prepared declaration, the one `folder.definition` holds.
 */
export async function saveRow({
	table,
	prepared,
	captured,
	edited,
	attempts = MERGE_ATTEMPTS,
}: {
	table: AnyTable;
	prepared: PreparedFolderTable;
	captured: StoredAnyRow;
	edited: AnyRow;
	attempts?: number;
}): Promise<SaveOutcome> {
	const stem = rowStemOf(table.name, captured.path);
	if (stem === undefined)
		return failed(`${captured.path} is not a row of ${table.name}.`);
	const { data: oursText, error: formatIssue } = formatRow(prepared, edited);
	if (formatIssue !== null) return failed(formatIssue.message);
	const { data: capturedText, error: baseIssue } = formatRow(
		prepared,
		captured.row,
	);
	if (baseIssue !== null) return failed(baseIssue.message);

	let capture: { path: string; sha256: string } = captured;
	let row = edited;
	let base = capturedText;
	let ours = oursText;
	const replaced: Replaced[] = [];

	for (let merges = 0; ; merges++) {
		const { data: stored, error } = await table.replace(capture, row);
		if (error === null)
			return replaced.length === 0 && merges === 0
				? { kind: 'saved', stored }
				: { kind: 'merged', stored, replaced };
		if (error.name === 'InvalidValues')
			return failed(
				`Not saved: ${error.issues.map((issue) => issue.message).join('; ')}`,
			);
		if (error.name !== 'Conflict') return failed(error.message);
		if (merges === attempts)
			return failed(
				'This row kept changing in another window, so your edit was not saved.',
			);

		const { data: current, error: readError } = await table.get(stem);
		if (readError !== null)
			return failed(
				readError.name === 'InvalidRow'
					? 'Another window saved this row in a form that does not read as a row, so your edit was not saved.'
					: readError.message,
			);
		if (current === undefined)
			return failed(
				'Another window deleted this row, so your edit was not saved.',
			);
		const { data: theirs, error: theirsIssue } = formatRow(
			prepared,
			current.row,
		);
		if (theirsIssue !== null) return failed(theirsIssue.message);

		const merge = await mergeRow(prepared, { base, ours, theirs });
		const settled = oursWins(merge);
		if (settled === undefined)
			return failed(
				'Your edit and another window’s changes to this row could not be merged, so your edit was not saved.',
			);
		replaced.push(...settled.replaced);
		row = settled.row;
		const { data: mergedText, error: mergedIssue } = formatRow(prepared, row);
		if (mergedIssue !== null) return failed(mergedIssue.message);
		capture = current;
		base = theirs;
		ours = mergedText;
	}
}

/**
 * The merged row with every competing field and body taken from ours, and
 * what of theirs that replaced. `undefined` for a merge by whole file.
 */
function oursWins(
	merge: RowMerge,
): { row: AnyRow; replaced: Replaced[] } | undefined {
	if (merge.kind === 'whole') return undefined;
	if (merge.kind === 'merged') return { row: copy(merge.row), replaced: [] };
	const row = copy(merge.row);
	const replaced: Replaced[] = [];
	for (const conflict of merge.fields) {
		// Ours left out is ours removing the field, which the merged row already does.
		if (conflict.ours !== undefined)
			Object.defineProperty(row.fields, conflict.field, {
				value: conflict.ours,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		replaced.push({
			kind: 'field',
			field: conflict.field,
			theirs: conflict.theirs,
		});
	}
	// While the body competes, the merged row's body is already ours.
	if (merge.body !== undefined)
		replaced.push({ kind: 'body', theirs: merge.body.theirs });
	return { row, replaced };
}

/** A row the caller owns, with fields as plain assignable properties. */
function copy(row: AnyRow): AnyRow {
	return { fields: { ...row.fields }, body: row.body };
}

function failed(message: string): SaveOutcome {
	return { kind: 'failed', message };
}
