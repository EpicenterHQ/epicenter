/**
 * An edit of one row, or of one file's text, that holds its own starting
 * version (ADR-0548, ADR-0551).
 *
 * A draft captures the version at the first change, not when an editor
 * gains focus, and keeps the edit outside the cache. A refetch updates the
 * cache, never the draft, and the save sends the starting version, with its
 * content, as its base, so the save merges with whatever changed since.
 * "Changed elsewhere" is derived by comparing the cache's version with the
 * base's; the draft holds no state for it.
 *
 * After a save, the version written is the new base. When the save merged
 * another writer's change, edits made while it ran are merged onto that
 * version, so the next save does not undo what the merge took.
 *
 * Plain TypeScript with no framework: a Svelte wrapper keeps a draft in
 * `$state` and calls these.
 */
import type { ContentCapture, FileCapture } from './capture.js';
import { mergeLines } from './git/merge-lines.js';
import type { FileContent } from './merge-file.js';
import type { SaveRowVariables } from './query.js';
import { type AnyRow, mergeRows, setField } from './row-merge.js';
import type { Row } from './row-text.js';
import type { SavedFile } from './save-file.js';
import type { SavedRow, StoredRow } from './table.js';

/** Whether the cache's `current` is not the version `base` names. */
function movedFrom(
	base: FileCapture | undefined,
	current: FileCapture | undefined,
): boolean {
	if (base === undefined) return false;
	return (
		current === undefined ||
		current.path !== base.path ||
		current.sha256 !== base.sha256
	);
}

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
		changedElsewhere: (current) => movedFrom(base, current),
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

/**
 * What a file save sends: the version the edit started from, and the
 * content, as `files.write` takes them. A text draft sends its text; the
 * restore of what a save replaced may send bytes.
 */
export type SaveTextVariables = {
	readonly base: ContentCapture;
	readonly content: FileContent;
};

/** What a text draft sends: always its text. */
type SentText = {
	readonly base: ContentCapture;
	readonly content: string;
	readonly revision: number;
};

/** An edit of one file's exact text; see `Draft`. */
export type TextDraft = {
	/** The version the edit started from; `undefined` before the first change. */
	readonly base: ContentCapture | undefined;
	/** The text typed; `undefined` before the first change. */
	readonly text: string | undefined;
	/**
	 * Type `text`. The first change captures `current`, the file as the cache
	 * holds it now, as the base; later ones ignore it.
	 */
	change(current: ContentCapture, text: string): void;
	/** Whether the file changed since the edit started; false with no edit. */
	changedElsewhere(current: FileCapture | undefined): boolean;
	/** What the file save sends; `undefined` with no edit. */
	toSave(): SentText | undefined;
	/** A save of `sent` landed as `saved`; as `Draft.saved`. */
	saved(sent: SentText, saved: SavedFile): Promise<void>;
	/** Drop the edit. */
	discard(): void;
};

const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

export function createTextDraft(): TextDraft {
	let base: ContentCapture | undefined;
	let text: string | undefined;
	let revision = 0;
	return {
		get base() {
			return base;
		},
		get text() {
			return text;
		},
		change(current, next) {
			base ??= current;
			text = next;
			revision++;
		},
		changedElsewhere: (current) => movedFrom(base, current),
		toSave() {
			if (base === undefined || text === undefined) return undefined;
			return { base, content: text, revision };
		},
		async saved(sent, result) {
			if (sent.revision === revision) {
				base = undefined;
				text = undefined;
				return;
			}
			if (!result.merged) {
				base = result.stored;
				return;
			}
			const from = base;
			const written = utf8.decode(result.stored.bytes);
			for (;;) {
				const at = revision;
				const typed = text;
				if (typed === undefined || base !== from) return;
				// Lines typed since the save win where the merge changed them too.
				const merged = await mergeLines({
					base: sent.content,
					ours: typed,
					theirs: written,
				});
				if (at !== revision) continue;
				text = merged.ours;
				base = result.stored;
				return;
			}
		},
		discard() {
			base = undefined;
			text = undefined;
		},
	};
}
