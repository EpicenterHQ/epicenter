/**
 * Save one edited row of a data folder's table at once, and say what a
 * person needs to hear about it.
 *
 * The Folders window keeps no drafts, so every edit is saved as it is made,
 * over the row the edit began from (`row-edits.ts` keeps that row). The
 * engine's `table.save` merges with another window's newer save of the row
 * (ADR-0548): fields only one side changed keep that side's value, body lines
 * only one side changed keep that side's lines, and where both changed a
 * field or the same lines this edit wins and the result names what it
 * replaced. This module turns that result into the view's outcome, and each
 * refusal into words for a person.
 *
 * This module has no DOM and no Svelte, so it runs under `bun test` against a
 * folder opened by `@epicenter/folder/bun`.
 */

import type {
	AnyRow,
	FileTable,
	Replaced,
	StoredRow,
	TableSaveError,
} from '@epicenter/folder';

/** A table of a folder opened by its own declaration: rows are untyped. */
export type AnyTable = FileTable<Record<string, unknown>>;

/** A row as one read captured it. */
export type StoredAnyRow = StoredRow<Record<string, unknown>>;

export type { Replaced };

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

/** Save `edited` over `captured`, the row as the edit began from it. */
export async function saveRow({
	table,
	captured,
	edited,
}: {
	table: AnyTable;
	captured: StoredAnyRow;
	edited: AnyRow;
}): Promise<SaveOutcome> {
	const { data: saved, error } = await table.save(captured, edited);
	if (error !== null) return { kind: 'failed', message: failure(error) };
	if (!saved.merged) return { kind: 'saved', stored: saved.stored };
	return { kind: 'merged', stored: saved.stored, replaced: saved.replaced };
}

/** Why a save wrote nothing, for a person. */
function failure(error: TableSaveError): string {
	switch (error.name) {
		case 'InvalidValues':
			return `Not saved: ${error.issues.map((issue) => issue.message).join('; ')}`;
		case 'NotFound':
			return 'Another window deleted this row, so your edit was not saved.';
		case 'InvalidRow':
		case 'InvalidUtf8':
			return 'Another window saved this row in a form that does not read as a row, so your edit was not saved.';
		case 'KeptChanging':
			return 'This row kept changing in another window, so your edit was not saved.';
		default:
			return error.message;
	}
}
