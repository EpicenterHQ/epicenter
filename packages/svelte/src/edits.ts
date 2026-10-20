/**
 * `@epicenter/svelte/edits`: a folder's edit handles in a Svelte view.
 *
 * `createRowEdit(folder.tables.notes.edit(id), () => row)` and
 * `createTextEdit(folder.files.edit(path), () => bytes)` show what is held
 * over the source a view observes, with the folder's own saves its read may
 * not show yet (`edit.shown`). A read re-runs when input at that path
 * changes, through a subscription that lives while some effect reads it.
 *
 * Getters read the current projection without remembering which one was
 * read last. Commands use that same projection. Code that intentionally
 * edits an older snapshot uses the core handle's explicit `shown().source`.
 * The folder keeps input, timers, saves and failures as views come and go.
 * Creating a binding reads and holds nothing; make a new binding when its
 * row or path changes, for example in `$derived`.
 */
import type { Row } from '@epicenter/folder';
import type {
	ChangeResult,
	ExclusiveFile,
	RowEdit,
	RowEditChange,
	TextEdit,
} from '@epicenter/folder/edits';
import { ChangeError } from '@epicenter/folder/edits';
import { untrack } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';

/** The byte-order mark stays in the text, as saving it back expects. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Text shown over `TObserved`: definite when the bytes always are. */
type ShownText<TObserved extends Uint8Array | undefined> =
	TObserved extends Uint8Array ? string : string | undefined;

/** Re-run a reader when input or own saves at `edit.path` change, while any effect reads it. */
function tracker(edit: Pick<TextEdit, 'path' | 'subscribe'>) {
	return createSubscriber((update) =>
		edit.subscribe((path) => {
			if (path === undefined || path === edit.path) update();
		}),
	);
}

/**
 * Row `edit` over the row `observed` answers. `row` is as definite as that
 * source: a getter that can answer `undefined`, while a read loads or after
 * the row is gone, gives a `row` that can be `undefined`. Held input stays
 * readable through `pending` either way.
 */
export function createRowEdit<
	TRowSchema extends TSchema,
	TObserved extends Row<TRowSchema> | undefined,
>(edit: RowEdit<TRowSchema>, observed: () => TObserved) {
	const track = tracker(edit);
	function current() {
		const row = observed();
		return row === undefined
			? undefined
			: edit.shown(row as NonNullable<TObserved>);
	}
	return {
		path: edit.path,
		/** The observed row with own saves and held input over it. */
		get row(): TObserved {
			track();
			return current()?.row as TObserved;
		},
		/** The held input, or `undefined`. */
		get pending() {
			track();
			return edit.pending;
		},
		/** Whether input is refused: another action holds the file, or the folder closes. */
		get locked() {
			track();
			return edit.locked;
		},
		/**
		 * Type fields and body over the current row, as one change. Answers
		 * acceptance into memory or the refusal reason; saving happens later.
		 */
		change(change: RowEditChange<TRowSchema>): ChangeResult {
			const shown = untrack(current);
			return shown === undefined
				? ChangeError.NoSource()
				: edit.change(shown.source, change);
		},
		save: () => edit.save(),
		retry: () => edit.retry(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
	};
}

/**
 * File `edit` over the bytes `observed` answers. `text` is as definite as
 * that source; held text stays readable through `pending` either way, and
 * with nothing observed `text` still shows held text or the folder's own
 * saved text, to read and copy.
 */
export function createTextEdit<TObserved extends Uint8Array | undefined>(
	edit: TextEdit,
	observed: () => TObserved,
) {
	const track = tracker(edit);
	const current = () => edit.shown(observed());
	return {
		path: edit.path,
		/** The held text or fields over the observed bytes, else those bytes as text. */
		get text(): ShownText<TObserved> {
			track();
			const shown = current();
			// Held fields that no longer apply leave the source to show.
			return (shown.text ??
				(shown.source === undefined
					? undefined
					: decoder.decode(shown.source))) as ShownText<TObserved>;
		},
		get pending() {
			track();
			return edit.pending;
		},
		get locked() {
			track();
			return edit.locked;
		},
		/** Type the whole text over the current projection. Answers acceptance or the refusal reason. */
		change(text: string): ChangeResult {
			return edit.change(untrack(current).source, text);
		},
		/** Type frontmatter fields over the current projection. */
		changeFields(fields: Readonly<Record<string, unknown>>): ChangeResult {
			return edit.changeFields(untrack(current).source, fields);
		},
		save: () => edit.save(),
		retry: () => edit.retry(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
		exclusive: <T>(action: (file: ExclusiveFile) => Promise<T>) =>
			edit.exclusive(action),
	};
}
