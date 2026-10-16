/**
 * `@epicenter/folder/svelte`: what a component edits text through
 * (ADR-0548, ADR-0551, ADR-0576).
 *
 * A field is not drafted: a component holds what was typed in its own
 * `$state` and sends it with the table's `set`.
 *
 * `createBodyEditor({ row, write })` opens one row's body for a control. It
 * holds `from`, the row the edit started from, and `typed`, the body typed
 * and not yet in the file, and sends each save to the table's `write`
 * mutation as the change from `from` to `from` with the typed body. The
 * write merges it into the row as it is now, so fields and lines another
 * writer changed meanwhile stay, and the typed lines win where both changed
 * the same lines; the folder logs that, and nothing is shown (ADR-0575):
 *
 * ```ts
 * const writeNote = createMutation(() => folder.notes.write.mutationOptions());
 * const body = createBodyEditor({
 *   row: () => note.data ?? undefined,
 *   write: (change) => writeNote.mutateAsync({ stem, ...change }),
 * });
 * ```
 *
 * ```svelte
 * <Textarea bind:value={() => body.text ?? '', (text) => body.change(text)} onblur={() => body.save()} />
 * ```
 *
 * `createTextDraftState({ save })` is the same for a file's exact text, over
 * `files.save`: `createTextDraft()` whose `base` and `text` are tracked,
 * plus the one-save-at-a-time loop every editor needs. A failed save ends
 * the loop and keeps the draft, so nothing typed is lost; the next `save()`
 * tries again, and the failure itself is the mutation's to show. The
 * component decides when to call `save()`: after a pause in typing, and
 * when the person leaves the editor or it goes away.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { ContentCapture } from '../capture.js';
import {
	createTextDraft,
	type SaveTextVariables,
	type TextDraft,
	type WrittenText,
	writtenFile,
} from '../draft.js';
import type { Row } from '../row-text.js';
import type { SavedFile } from '../save-file.js';
import type { StoredRow } from '../table.js';

export type TextDraftState<TBase extends ContentCapture = ContentCapture> =
	Pick<TextDraft<TBase>, 'base' | 'text' | 'change' | 'discard'> & {
		/** Whether a save of this draft is running. */
		readonly saving: boolean;
		/**
		 * Save the draft, one save at a time, until no change is left unsent.
		 * Called while a save runs, it resolves when that loop ends. A failed
		 * save ends the loop and keeps the draft; its error is the mutation's.
		 */
		save(): Promise<void>;
	};

/** The reactive draft over `save`. `written` reads what a save wrote. */
function draftState<TBase extends ContentCapture, TSaved>({
	save,
	written,
}: {
	save: (sent: {
		readonly base: TBase;
		readonly content: string;
	}) => Promise<TSaved>;
	written: (saved: TSaved) => WrittenText<TBase>;
}): TextDraftState<TBase> {
	const draft = createTextDraft<TBase>();
	/** Reads of the draft subscribe; every change to it wakes them. */
	let wake: (() => void) | undefined;
	const track = createSubscriber((update) => {
		wake = update;
		return () => {
			wake = undefined;
		};
	});
	let running: Promise<void> | undefined = $state();

	/** Started only with something to send, so it awaits before it ends. */
	async function loop() {
		try {
			for (let sent = draft.toSave(); sent; sent = draft.toSave()) {
				const { base, content } = sent;
				const saved = await save({ base, content }).catch(() => undefined);
				// The mutation holds the error; the draft keeps the edit.
				if (saved === undefined) return;
				await draft.saved(sent, written(saved));
				wake?.();
			}
		} finally {
			running = undefined;
		}
	}

	return {
		get base() {
			track();
			return draft.base;
		},
		get text() {
			track();
			return draft.text;
		},
		get saving() {
			return running !== undefined;
		},
		change(current, text) {
			draft.change(current, text);
			wake?.();
		},
		discard() {
			draft.discard();
			wake?.();
		},
		save() {
			if (running !== undefined) return running;
			if (draft.toSave() === undefined) return Promise.resolve();
			running = loop();
			return running;
		},
	};
}

export function createTextDraftState({
	save,
}: {
	/** Write one save of the file: the files' write mutation, rejecting on failure. */
	save: (sent: SaveTextVariables) => Promise<SavedFile>;
}): TextDraftState {
	return draftState({ save, written: writtenFile });
}

/** One row's body, opened for a control (ADR-0576). */
export type BodyEditor = {
	/** What the control shows: the text typed, or the body as the file holds it; `undefined` with no row. */
	readonly text: string | undefined;
	/** The text typed and not yet in the file; `undefined` when nothing is. */
	readonly typed: string | undefined;
	/** Whether a save of the body is running. */
	readonly saving: boolean;
	/**
	 * Whether the row is gone with text typed into it: deleted elsewhere,
	 * as the cache says or a save found. Nothing saves that text; the
	 * control offers it until the person copies or discards it.
	 */
	readonly gone: boolean;
	/** Type `text`. The first change takes the row as the cache holds it as `from`. */
	change(text: string): void;
	/**
	 * Save what is typed, one save at a time, until nothing typed is
	 * unsent. Called while a save runs, it resolves when that loop ends. A
	 * failed save keeps what is typed; its error is the mutation's. A save
	 * of a row deleted since writes nothing (a delete beats an edit it never
	 * saw), and nothing is sent while the row is gone from the cache: what is
	 * typed stays, and `gone` says so.
	 */
	save(): Promise<void>;
	/** Drop what is typed. */
	discard(): void;
};

/** A body as the file stores it: line feeds, and well-formed text (ADR-0572). */
const storable = (text: string) => text.replace(/\r\n?/g, '\n').toWellFormed();

export function createBodyEditor<TFields>({
	row,
	write,
}: {
	/** The row as the cache holds it now; `undefined` while it is absent or does not read as a row. */
	row: () => StoredRow<TFields> | undefined;
	/**
	 * Write the change from `from` to `to`, rejecting on failure:
	 * `mutateAsync` of `folder.<table>.write` with the row's stem. It
	 * resolves with the row written, or `null` when the row is gone.
	 */
	write: (change: {
		readonly from: Row<TFields>;
		readonly to: Row<TFields>;
	}) => Promise<StoredRow<TFields> | null>;
}): BodyEditor {
	/** The row the edit started from, then the row each landed save sent. */
	let from: Row<TFields> | undefined = $state.raw();
	let typed: string | undefined = $state.raw();
	let running: Promise<void> | undefined = $state.raw();
	/** A save found the row deleted. */
	let deleted = $state.raw(false);

	/** Started only with something to send, so it awaits before it ends. */
	async function loop() {
		try {
			while (from !== undefined && typed !== undefined) {
				if (row() === undefined) return;
				const base = from;
				const sent = storable(typed);
				const landed = await write({
					from: base,
					to: { fields: base.fields, body: sent },
				}).then(
					(row) => (row === null ? 'gone' : 'landed'),
					() => 'failed' as const,
				);
				// The mutation holds the error; what is typed stays.
				if (landed === 'failed') return;
				if (landed === 'gone') {
					if (from === base) deleted = true;
					return;
				}
				// Discarded, or discarded and begun again, while it ran.
				if (from !== base || typed === undefined) return;
				if (storable(typed) === sent) {
					from = undefined;
					typed = undefined;
					return;
				}
				// Typing continued: the next save starts from what this one
				// sent, so it changes only what was typed since.
				from = { fields: base.fields, body: sent };
			}
		} finally {
			running = undefined;
		}
	}

	return {
		get text() {
			return typed ?? row()?.row.body;
		},
		get typed() {
			return typed;
		},
		get saving() {
			return running !== undefined;
		},
		get gone() {
			return typed !== undefined && (deleted || row() === undefined);
		},
		change(text) {
			if (from === undefined) {
				const current = row();
				if (current === undefined) return;
				from = current.row;
			}
			typed = text;
		},
		save() {
			if (running !== undefined) return running;
			// Nothing to send, or no row to send it to: the loop would end
			// before it first awaits.
			if (
				from === undefined ||
				typed === undefined ||
				deleted ||
				row() === undefined
			)
				return Promise.resolve();
			running = loop();
			return running;
		},
		discard() {
			from = undefined;
			typed = undefined;
			deleted = false;
		},
	};
}
