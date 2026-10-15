/**
 * The row each edit of the Folders window started from.
 *
 * An edit is merged against the row the person saw when they began it, not
 * the row the grid shows when the save runs: a read in between (window focus,
 * another window's save) may have put the other window's newer row in the
 * grid, and an edit captured from that row would replace their change with no
 * conflict. So each editor records the row when editing begins (`begin`: a
 * text box's focus, a checkbox's or chip's click), and the save takes that
 * record (`take`) as its base.
 *
 * Saves this window made are followed (`saved`, `latest`): an edit begun
 * before an earlier save of the same row landed is saved over that save's
 * result, so this window's own saves never read as another window's change.
 * The edit itself is replayed over that row (`editedRow`): a field change
 * sets or removes that field, and a body edit is merged by line, so whatever
 * the earlier save merged in from another window stays.
 *
 * This module has no DOM and no Svelte, so it runs under `bun test`.
 */

import { type AnyRow, mergeLinesPreferring } from '@epicenter/folder';
import type { StoredAnyRow } from './save-row';

/** What an edit does to one field: set its value, or leave it out of the row. */
export type FieldChange =
	| { readonly kind: 'set'; readonly value: unknown }
	| { readonly kind: 'remove' };

/** One committed edit of a row: one field, or the whole body text. */
export type RowEdit =
	| {
			readonly kind: 'field';
			readonly field: string;
			readonly change: FieldChange;
	  }
	| { readonly kind: 'body'; readonly text: string };

/** Which editor of a row an edit came from: a field's name, or the body. */
export type EditUnit =
	| { readonly kind: 'field'; readonly field: string }
	| { readonly kind: 'body' };

export type RowEdits = ReturnType<typeof createRowEdits>;

const unitKey = (unit: EditUnit) =>
	unit.kind === 'body' ? 'body' : `field:${unit.field}`;

export function createRowEdits() {
	/** The row each open edit began from, by table, row stem, and editor. */
	const started = new Map<string, StoredAnyRow>();
	/** What each of this window's saves left, by path and the bytes it saved over. */
	const own = new Map<string, StoredAnyRow>();
	const key = (table: string, stem: string, unit: EditUnit) =>
		JSON.stringify([table, stem, unitKey(unit)]);
	const ownKey = (row: { path: string; sha256: string }) =>
		JSON.stringify([row.path, row.sha256]);

	return {
		/** Editing `unit` of the row began, as `stored` shows it. A later begin replaces it. */
		begin(table: string, stem: string, unit: EditUnit, stored: StoredAnyRow) {
			started.set(key(table, stem, unit), stored);
		},
		/**
		 * The row the edit being saved began from, which is then forgotten.
		 * `undefined` when no begin was recorded for it.
		 */
		take(
			table: string,
			stem: string,
			unit: EditUnit,
		): StoredAnyRow | undefined {
			const at = key(table, stem, unit);
			const stored = started.get(at);
			started.delete(at);
			return stored;
		},
		/** This window saved `stored` over `captured`. */
		saved(captured: StoredAnyRow, stored: StoredAnyRow) {
			own.set(ownKey(captured), stored);
		},
		/** `stored`, or what this window's saves since made of it. */
		latest(stored: StoredAnyRow): StoredAnyRow {
			let current = stored;
			const seen = new Set<string>();
			for (;;) {
				const at = ownKey(current);
				const next = own.get(at);
				if (next === undefined || seen.has(at)) return current;
				seen.add(at);
				current = next;
			}
		},
	};
}

/**
 * The row `edit` saves when it is made over `base`, having begun over
 * `start`. A field change applies to `base`'s fields. A body edit replaced
 * `start`'s body; where `base` has another body (this window saved one
 * since), the two merge by line and this edit wins where both changed.
 */
export async function editedRow(
	start: StoredAnyRow,
	base: StoredAnyRow,
	edit: RowEdit,
): Promise<AnyRow> {
	const fields = { ...base.row.fields };
	if (edit.kind === 'body') {
		const body =
			base.row.body === start.row.body
				? edit.text
				: (
						await mergeLinesPreferring(
							{
								base: start.row.body,
								ours: edit.text,
								theirs: base.row.body,
							},
							'ours',
						)
					).text;
		return { fields, body };
	}
	if (edit.change.kind === 'remove') delete fields[edit.field];
	else
		Object.defineProperty(fields, edit.field, {
			value: edit.change.value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	return { fields, body: base.row.body };
}
