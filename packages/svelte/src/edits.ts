/**
 * `@epicenter/svelte/edits`: a folder's edit handles in a Svelte view.
 *
 * `createRowEdit(folder.tables.notes.edit(id), () => row)` and
 * `createTextEdit(folder.files.edit(path), () => bytes)` show what is held
 * over the source a view observes, with the folder's own saves its read may
 * not show yet (`edit.shown`). A read re-runs when input at that path
 * changes, through a subscription that lives while some effect reads it.
 *
 * A change names what the view last showed: the `shown` value its last read
 * of `row` or `text` answered, so typing over what the person saw keeps
 * meaning that even when held input or the source moved on since. A
 * command that composes its change from the row reads `seen`, which is that
 * same row, so composing never moves what the change names. The
 * folder keeps the input, its timers, saves and failures, whatever views
 * come and go. Creating a binding reads and holds nothing, so a view whose
 * row or path changes makes a new one, for example in `$derived`.
 */
import type { Row } from '@epicenter/folder';
import type {
	ExclusiveFile,
	RowEdit,
	RowEditChange,
	RowShown,
	TextEdit,
	TextShown,
} from '@epicenter/folder/edits';
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
	/** What this view last showed: set only by a read of `row`. */
	let displayed: RowShown<NonNullable<TObserved>> | undefined;
	/** What `observed` would show now, recording nothing. */
	function answer() {
		const row = observed();
		return row === undefined
			? undefined
			: edit.shown(row as NonNullable<TObserved>);
	}
	/** What a command names: what this view last showed, else what it would show now. */
	const named = () => displayed ?? untrack(answer);
	return {
		path: edit.path,
		/** The observed row with own saves and held input over it. */
		get row(): TObserved {
			track();
			const shown = answer();
			if (shown !== undefined) displayed = shown;
			return shown?.row as TObserved;
		},
		/**
		 * The row the next `change` types over: what this view last showed,
		 * or with nothing shown yet, what it would show now. Reading it shows
		 * nothing and is not reactive, so a command can compose its change
		 * from it without moving what the change names.
		 */
		get seen(): TObserved {
			return named()?.row as TObserved;
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
		 * Type fields and body over the row this view last showed, as one
		 * change. Answers whether it was taken.
		 */
		change(change: RowEditChange<TRowSchema>): boolean {
			// No row is observed now: it is loading, or gone.
			if (untrack(observed) === undefined) return false;
			const shown = named();
			return shown !== undefined && edit.change(shown.source, change);
		},
		save: () => edit.save(),
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
	/** What this view last showed: set only by a read of `text`. */
	let displayed: TextShown | undefined;
	/** What a command names: what this view last showed, else what it would show now. */
	const named = () => displayed ?? untrack(() => edit.shown(observed()));
	return {
		path: edit.path,
		/** The held text or fields over the observed bytes, else those bytes as text. */
		get text(): ShownText<TObserved> {
			track();
			const shown = edit.shown(observed());
			displayed = shown;
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
		/** Type the whole text over what this view last showed. Answers whether it was taken. */
		change(text: string): boolean {
			return edit.change(named().source, text);
		},
		/** Type frontmatter fields over what this view last showed. */
		changeFields(fields: Readonly<Record<string, unknown>>): boolean {
			return edit.changeFields(named().source, fields);
		},
		save: () => edit.save(),
		retry: () => edit.retry(),
		discard: () => edit.discard(),
		delete: () => edit.delete(),
		exclusive: <T>(action: (file: ExclusiveFile) => Promise<T>) =>
			edit.exclusive(action),
	};
}
