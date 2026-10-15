/**
 * An edit of one row that holds its own starting version (ADR-0548).
 *
 * The draft captures the row and its version at the first change, not when
 * an editor gains focus, and keeps the edited row outside the cache. A
 * refetch updates the cache, never the draft, and the save sends the
 * starting version as its base, so `table.save` merges with whatever
 * changed since. "Changed elsewhere" is derived by comparing the cache's
 * version with the base's; the draft holds no state for it.
 *
 * Plain TypeScript with no framework: a Svelte wrapper keeps a draft in
 * `$state` and calls these.
 */
import type { FileCapture } from './capture.js';
import type { SaveRowVariables } from './query.js';
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
	 * done. Otherwise the later changes continue from the row `sent`: what
	 * the saved version holds beyond it was merged in from another writer,
	 * and is not this edit's to undo.
	 */
	saved(
		sent: SaveRowVariables<TFields> & { readonly revision: number },
		saved: SavedRow<TFields>,
	): void;
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
		saved(sent, result) {
			if (sent.revision === revision) {
				base = undefined;
				row = undefined;
				return;
			}
			// Changes made while the save ran are still unsaved, and their base
			// row is the one sent. Unmerged, the file holds exactly that row, so
			// the next save writes over the version written. Merged, the file
			// also holds another writer's changes, which a save over the version
			// written would undo, since `table.save` writes a current capture's
			// row as given. So the base keeps naming the version the sent save
			// started from: the next save finds the file moved and merges the
			// draft with it over the row sent.
			base = {
				path: result.stored.path,
				sha256: result.merged ? sent.base.sha256 : result.stored.sha256,
				row: sent.row,
			};
		},
		discard() {
			base = undefined;
			row = undefined;
		},
	};
}
