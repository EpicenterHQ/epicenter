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
	 * done. Otherwise the later changes continue from the saved version.
	 */
	saved(sent: { readonly revision: number }, saved: SavedRow<TFields>): void;
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
			// Changes made while the save ran are still unsaved; they started
			// from what it wrote.
			base = result.stored;
		},
		discard() {
			base = undefined;
			row = undefined;
		},
	};
}

/** A version of a row file, and the row an edit of it started from. */
type Base<TFields> = FileCapture & { readonly row: Row<TFields> };

/**
 * The base each save needs, for a cache that holds edited rows in place:
 * each entry keeps the confirmed version's capture with the edited row, so
 * the row that version held is gone by the time the save runs. Keyed by
 * whatever names a row in the cache (its stem, or its path).
 *
 * Record a row with `editing` just before the cache first changes it, save
 * with `baseOf`, and report each landed save with `saved`. A save whose
 * cached version has no record has no base (see `table.save`).
 */
export function createSaveBases<TFields>() {
	const bases = new Map<string, Base<TFields>>();
	const same = (left: FileCapture, right: FileCapture) =>
		left.path === right.path && left.sha256 === right.sha256;
	return {
		/**
		 * The cache is about to change `stored`, its row as it holds it now.
		 * The first change at a version records that version's row.
		 */
		editing(key: string, stored: Base<TFields>) {
			const known = bases.get(key);
			if (known !== undefined && same(known, stored)) return;
			bases.set(key, {
				path: stored.path,
				sha256: stored.sha256,
				row: structuredClone(stored.row),
			});
		},
		/** What to save `stored`, the cache's edited row, over. */
		baseOf(
			key: string,
			stored: FileCapture,
		): FileCapture & { readonly row?: Row<TFields> } {
			const known = bases.get(key);
			if (known !== undefined && same(known, stored)) return known;
			return { path: stored.path, sha256: stored.sha256 };
		},
		/**
		 * A save of `sent` landed as `saved`. Edits made since continue from
		 * `sent`, at the version written: what the file holds beyond it, merged
		 * in from another writer, is theirs, not this cache's to undo.
		 */
		saved(key: string, sent: Row<TFields>, saved: SavedRow<TFields>) {
			bases.set(key, {
				path: saved.stored.path,
				sha256: saved.stored.sha256,
				row: structuredClone(sent),
			});
		},
		/** Forget `key`, as when its row was read again or removed. */
		forget(key: string) {
			bases.delete(key);
		},
	};
}

export type SaveBases<TFields> = ReturnType<typeof createSaveBases<TFields>>;
