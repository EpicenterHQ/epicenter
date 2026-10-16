/**
 * `@epicenter/folder/svelte`: a document's text draft a component reads
 * reactively (ADR-0548, ADR-0551, ADR-0554).
 *
 * A field is not drafted: a component holds what was typed in its own
 * `$state` and sends it with `table.update`. A document's text is drafted,
 * because its save needs the version the edit started from.
 *
 * `createTextDraftState({ save })` is `createTextDraft()` whose `base` and
 * `text` are tracked, plus the one-save-at-a-time loop every editor needs:
 * `save()` sends what the draft holds, and when the text changed while that
 * save ran, it sends again from the version it wrote. A failed save ends the
 * loop and keeps the draft, so nothing typed is lost; the next `save()` tries
 * again. The failure itself is the mutation's to show. The component decides
 * when to call `save()`: after a pause in typing, and when the person leaves
 * the editor or it goes away.
 *
 * `save` is the files' write mutation, sent `{ base, content }`, as a
 * promise that rejects on failure. Where another writer changed the same
 * lines, the save wins; the folder logs it, and nothing is shown
 * (ADR-0575).
 *
 * `createBodyDraftState({ save })` is the same for one row's body: `save`
 * replaces the body of the row the draft started from.
 *
 * `createBodyEditor({ row, save })` opens one row's body for a control
 * (ADR-0575). It reads the row as the cache holds it, sends the body typed
 * with the row it started from to the table's `setBody` mutation, which
 * replaces only the body on the file as it is now, and shows the draft's
 * text or the file's body:
 *
 * ```ts
 * const setBody = createMutation(() => folder.notes.setBody.mutationOptions());
 * const body = createBodyEditor({ row: () => note.data ?? undefined, save: (v) => setBody.mutateAsync(v) });
 * ```
 *
 * ```svelte
 * <Textarea bind:value={() => body.text ?? '', (text) => body.change(text)} onblur={() => body.save()} />
 * ```
 */
import { createSubscriber } from 'svelte/reactivity';
import type { ContentCapture } from '../capture.js';
import {
	createTextDraft,
	type SaveTextVariables,
	type TextDraft,
	type WrittenText,
	writtenBody,
	writtenFile,
} from '../draft.js';
import type { SavedFile } from '../save-file.js';
import type { SavedRow, StoredRow } from '../table.js';

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

export function createBodyDraftState<TFields>({
	save,
}: {
	/**
	 * Replace the body of `base`, the row the draft started from, with
	 * `content`: the table's `setBody` mutation, rejecting on failure.
	 */
	save: (sent: {
		readonly base: StoredRow<TFields>;
		readonly content: string;
	}) => Promise<SavedRow<TFields>>;
}): TextDraftState<StoredRow<TFields>> {
	return draftState({ save, written: writtenBody<TFields> });
}

/** One row's body, opened for a control (ADR-0575). */
export type BodyEditor = {
	/** What the control shows: the text typed, or the body as the file holds it; `undefined` with no row. */
	readonly text: string | undefined;
	/** The text typed and not yet in the file; `undefined` when nothing is. */
	readonly typed: string | undefined;
	/** Whether a save of the body is running. */
	readonly saving: boolean;
	/** Type `text`. The first change takes the row as the cache holds it as the starting version. */
	change(text: string): void;
	/** Save what is typed, one save at a time; a failed save keeps it. */
	save(): Promise<void>;
	/** Drop what is typed. */
	discard(): void;
};

export function createBodyEditor<TFields>({
	row,
	save,
}: {
	/** The row as the cache holds it now; `undefined` while it is absent or does not read as a row. */
	row: () => StoredRow<TFields> | undefined;
	/** The table's body write, rejecting on failure: `mutateAsync` of `folder.<table>.setBody`. */
	save: (variables: {
		readonly base: StoredRow<TFields>;
		readonly text: string;
	}) => Promise<SavedRow<TFields>>;
}): BodyEditor {
	const draft = createBodyDraftState<TFields>({
		save: ({ base, content }) => save({ base, text: content }),
	});
	return {
		get text() {
			return draft.text ?? row()?.row.body;
		},
		get typed() {
			return draft.text;
		},
		get saving() {
			return draft.saving;
		},
		change(text) {
			const current = row();
			if (current !== undefined) draft.change(current, text);
		},
		save: () => draft.save(),
		discard: () => draft.discard(),
	};
}
