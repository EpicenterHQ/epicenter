/**
 * An edit of one row that holds its own starting version (ADR-0548).
 *
 * The draft captures the row and its version at the first change, not when
 * an editor gains focus, and keeps the edited row outside the cache. A
 * refetch updates the cache, never the draft, and the save sends the
 * starting version, with its content, as its base, so `table.save` merges
 * with whatever changed since (ADR-0551). "Changed elsewhere" is derived by comparing the cache's
 * version with the base's; the draft holds no state for it.
 *
 * Plain TypeScript with no framework: a Svelte wrapper keeps a draft in
 * `$state` and calls these.
 */
import type { FileCapture } from './capture.js';
import type { SaveRowVariables } from './query.js';
import { type AnyRow, mergeRows, setField } from './row-merge.js';
import type { Row } from './row-text.js';
import type { SavedRow, StoredRow } from './table.js';

export type Draft<TFields> = {
	/** The row and version the edit started from; `undefined` before the first change. */
	readonly base: StoredRow<TFields> | undefined;
	/** The edited row; `undefined` before the first change. */
	readonly row: Row<TFields> | undefined;
	/**
	 * Make a change. The first one captures `current`, the row as the cache
	 * holds it now, as the base and edits a copy of its row; later ones edit
	 * the draft's row and ignore `current`.
	 */
	change(current: StoredRow<TFields>, edit: (row: Row<TFields>) => void): void;
	/**
	 * Whether the file changed since the edit started: `current`, the row as
	 * the cache holds it, is not the base's version. False with no edit.
	 */
	changedElsewhere(current: FileCapture | undefined): boolean;
	/** What the table's save mutation sends; `undefined` with no edit. */
	toSave():
		| (SaveRowVariables<TFields> & { readonly revision: number })
		| undefined;
	/**
	 * A save of `sent` landed as `saved`. With no change since, the draft is
	 * done. Otherwise the written version is the new base, and the later
	 * changes continue from it: when the save merged, what the written
	 * version holds beyond the row sent came from another writer, so the
	 * later changes are merged onto it, keeping it, rather than undoing it.
	 * Changes made while that merge runs are merged too.
	 */
	saved(
		sent: SaveRowVariables<TFields> & { readonly revision: number },
		saved: SavedRow<TFields>,
	): Promise<void>;
	/** Drop the edit. */
	discard(): void;
};

export function createDraft<TFields>(): Draft<TFields> {
	let base: StoredRow<TFields> | undefined;
	let row: Row<TFields> | undefined;
	/** Counts changes, so a save knows whether the draft moved on while it ran. */
	let revision = 0;
	return {
		get base() {
			return base;
		},
		get row() {
			return row;
		},
		change(current, edit) {
			if (base === undefined || row === undefined) {
				base = current;
				row = structuredClone(current.row);
			}
			edit(row);
			revision++;
		},
		changedElsewhere(current) {
			if (base === undefined) return false;
			return (
				current === undefined ||
				current.path !== base.path ||
				current.sha256 !== base.sha256
			);
		},
		toSave() {
			if (base === undefined || row === undefined) return undefined;
			return { base, row: structuredClone(row), revision };
		},
		async saved(sent, result) {
			if (sent.revision === revision) {
				base = undefined;
				row = undefined;
				return;
			}
			if (!result.merged) {
				// The file holds the row sent, so the later changes are exactly
				// what the draft's row holds beyond the version written.
				base = result.stored;
				return;
			}
			const from = base;
			for (;;) {
				const at = revision;
				const edited = row;
				// Discarded, or discarded and begun again, while the merge ran.
				if (edited === undefined || base !== from) return;
				const merged = await mergeRows(
					sent.row as AnyRow,
					edited as AnyRow,
					result.stored.row as AnyRow,
				);
				// A change made during the merge edited the row it read; merge again.
				if (at !== revision || row !== edited) continue;
				// Where both changed one value, the draft's later change wins.
				const fields = { ...merged.fields };
				for (const conflict of merged.conflicts)
					setField(fields, conflict.field, conflict.ours);
				row = { fields, body: merged.body.ours } as Row<TFields>;
				base = result.stored;
				return;
			}
		},
		discard() {
			base = undefined;
			row = undefined;
		},
	};
}
