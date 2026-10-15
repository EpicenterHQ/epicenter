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
 * promise that rejects on failure. `onSaved` hears each save that landed,
 * with `restore`: one more save, of `restoreTheirs(saved)` through the same
 * `save`, that puts back what it replaced of another writer's change; its
 * own result is heard the same way. Restoring a file at a row path or
 * `kv.json` needs the folder's `definition`.
 *
 * `createBodyDraftState({ save })` is the same for one row's body: `save`
 * writes the body over the row the draft started from, as `table.save`
 * does, and the app decides which fields go with it.
 *
 * ```ts
 * const save = createMutation(() => folder$.notes.save.mutationOptions());
 * const body = createBodyDraftState<NoteFields>({
 *   save: ({ base, content }) =>
 *     save.mutateAsync({ base, row: { fields: base.row.fields, body: content } }),
 * });
 * const shown = $derived(body.text ?? note.data?.row.body);
 * body.change(note.data, typed);
 * ```
 */
import { createSubscriber } from 'svelte/reactivity';
import type { ContentCapture } from '../capture.js';
import type { FolderDefinition } from '../definition.js';
import {
	createTextDraft,
	type SaveTextVariables,
	type TextDraft,
	type WrittenText,
	writtenBody,
	writtenFile,
} from '../draft.js';
import { restoreTheirs, type SavedFile } from '../save-file.js';
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

/** What a draft state hears of each save that landed, with the save that restores theirs. */
type OnSaved<TSaved> = (saved: TSaved, restore: () => void) => void;

/**
 * The reactive draft over `save`. `written` reads what a save wrote, and
 * `theirs` builds the save that restores what it replaced.
 */
function draftState<TBase extends ContentCapture, TSent, TSaved>({
	save,
	written,
	theirs,
	onSaved,
}: {
	save: (
		sent: TSent | { readonly base: TBase; readonly content: string },
	) => Promise<TSaved>;
	written: (saved: TSaved) => WrittenText<TBase>;
	theirs: (saved: TSaved) => TSent;
	onSaved: OnSaved<TSaved> | undefined;
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

	const hear =
		onSaved === undefined
			? undefined
			: (saved: TSaved) =>
					onSaved(saved, () => void save(theirs(saved)).then(hear, () => {}));

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
				hear?.(saved);
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
	onSaved,
	definition,
}: {
	/** Write one save of the file: the files' write mutation, rejecting on failure. */
	save: (sent: SaveTextVariables) => Promise<SavedFile>;
	/** Each save that landed, as for a notice of what it replaced, and the save that restores it. */
	onSaved?: OnSaved<SavedFile>;
	/** The folder's definition, which restoring a row file or `kv.json` by field or key needs. */
	definition?: FolderDefinition;
}): TextDraftState {
	return draftState({
		save,
		written: writtenFile,
		theirs: (saved) => restoreTheirs(saved, definition),
		onSaved,
	});
}

export function createBodyDraftState<TFields>({
	save,
	onSaved,
}: {
	/**
	 * Write the body `content` over `base`, the row the draft started from:
	 * the table's save mutation, rejecting on failure.
	 */
	save: (sent: {
		readonly base: StoredRow<TFields>;
		readonly content: string;
	}) => Promise<SavedRow<TFields>>;
	/** Each save that landed, as for a notice of what it replaced, and the save that restores it. */
	onSaved?: OnSaved<SavedRow<TFields>>;
}): TextDraftState<StoredRow<TFields>> {
	return draftState({
		save,
		written: writtenBody<TFields>,
		theirs: (saved) => ({
			base: saved.stored,
			content: restoreTheirs(saved).row.body,
		}),
		onSaved,
	});
}
