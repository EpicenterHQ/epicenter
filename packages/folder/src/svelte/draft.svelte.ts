/**
 * `@epicenter/folder/svelte`: a draft a component reads reactively
 * (ADR-0548, ADR-0551).
 *
 * `createDraftState({ save })` is `createDraft()` whose `base`, `row`, and
 * `changedElsewhere` are tracked, plus the one-save-at-a-time loop every
 * editor needs: `save()` sends what the draft holds, and when changes were
 * made while that save ran, it sends again from the version it wrote. A
 * failed save ends the loop and keeps the draft, so nothing typed is lost;
 * the next `save()` tries again. The failure itself is the mutation's to
 * show.
 *
 * `save` is the table's save mutation, as a promise that rejects on failure.
 * `onSaved` hears each save that landed, with `restore`: one more save, of
 * `restoreTheirs(saved)` through the same `save`, that puts back what it
 * replaced of another writer's change; its own result is heard the same way.
 *
 * ```ts
 * const save = createMutation(() => folder$.todos.save.mutationOptions());
 * const draft = createDraftState<TodoFields>({
 *   save: (sent) => save.mutateAsync(sent),
 *   onSaved: ({ replaced }, restore) => toastReplaced({ replaced, restore }),
 * });
 * const shown = $derived(draft.row ?? todo.data?.row);
 * draft.change(todo.data, (row) => { row.fields.title = title; });
 * void draft.save();
 * ```
 *
 * `createTextDraftState({ save })` is the same for one file's exact text,
 * over `createTextDraft()`; `save` is the files' write mutation, sent
 * `{ base, content }`. Restoring a file at a row path or `kv.json` needs
 * the folder's `definition`.
 */
import { createSubscriber } from 'svelte/reactivity';
import type { FolderDefinition } from '../definition.js';
import {
	createDraft,
	createTextDraft,
	type Draft,
	type SaveTextVariables,
	type TextDraft,
} from '../draft.js';
import type { SaveRowVariables } from '../query.js';
import { restoreTheirs, type SavedFile } from '../save-file.js';
import type { SavedRow } from '../table.js';

/** The reactive half every draft state shares: a save loop and change tracking. */
type Loop = {
	/** Whether a save of this draft is running. */
	readonly saving: boolean;
	/**
	 * Save the draft, one save at a time, until no change is left unsent.
	 * Called while a save runs, it resolves when that loop ends. A failed
	 * save ends the loop and keeps the draft; its error is the mutation's.
	 */
	save(): Promise<void>;
};

export type DraftState<TFields> = Pick<
	Draft<TFields>,
	'base' | 'row' | 'change' | 'changedElsewhere' | 'discard'
> &
	Loop;

export type TextDraftState = Pick<
	TextDraft,
	'base' | 'text' | 'change' | 'changedElsewhere' | 'discard'
> &
	Loop;

/** What a draft state hears of each save that landed, with the save that restores theirs. */
type OnSaved<TSaved> = (saved: TSaved, restore: () => void) => void;

/**
 * `onSaved` with each save's `restore`: one more `save` of what `theirs`
 * builds from it, heard the same way. A failed restore is the save's to
 * report.
 */
function heard<TSent, TSaved>(
	save: (sent: TSent) => Promise<TSaved>,
	theirs: (saved: TSaved) => TSent,
	onSaved: OnSaved<TSaved> | undefined,
) {
	if (onSaved === undefined) return undefined;
	const hear = (saved: TSaved) =>
		onSaved(saved, () => void save(theirs(saved)).then(hear, () => {}));
	return hear;
}

/**
 * The save loop over `draft`: `track` subscribes a read, `changed` wakes
 * every read. Sends what the draft holds until nothing is left.
 */
function saveLoop<TSent extends { readonly revision: number }, TSaved>(
	draft: {
		toSave(): TSent | undefined;
		saved(sent: TSent, saved: TSaved): Promise<void>;
	},
	save: (sent: TSent) => Promise<TSaved>,
	onSaved: ((saved: TSaved) => void) | undefined,
) {
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
				const saved = await save(sent).catch(() => undefined);
				// The mutation holds the error; the draft keeps the edit.
				if (saved === undefined) return;
				await draft.saved(sent, saved);
				wake?.();
				onSaved?.(saved);
			}
		} finally {
			running = undefined;
		}
	}

	return {
		track,
		changed: () => wake?.(),
		get saving() {
			return running !== undefined;
		},
		save() {
			if (running !== undefined) return running;
			if (draft.toSave() === undefined) return Promise.resolve();
			running = loop();
			return running;
		},
	};
}

export function createDraftState<TFields>({
	save,
	onSaved,
}: {
	/** Write one save: the table's save mutation, rejecting on failure. */
	save: (sent: SaveRowVariables<TFields>) => Promise<SavedRow<TFields>>;
	/** Each save that landed, as for a notice of what it replaced, and the save that restores it. */
	onSaved?: OnSaved<SavedRow<TFields>>;
}): DraftState<TFields> {
	const draft = createDraft<TFields>();
	const reactive = saveLoop(
		draft,
		({ base, row }) => save({ base, row }),
		heard(save, restoreTheirs, onSaved),
	);
	return {
		get base() {
			reactive.track();
			return draft.base;
		},
		get row() {
			reactive.track();
			return draft.row;
		},
		get saving() {
			return reactive.saving;
		},
		change(current, edit) {
			draft.change(current, edit);
			reactive.changed();
		},
		changedElsewhere(current) {
			reactive.track();
			return draft.changedElsewhere(current);
		},
		discard() {
			draft.discard();
			reactive.changed();
		},
		save: reactive.save,
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
	const draft = createTextDraft();
	const reactive = saveLoop(
		draft,
		({ base, content }) => save({ base, content }),
		heard(save, (saved) => restoreTheirs(saved, definition), onSaved),
	);
	return {
		get base() {
			reactive.track();
			return draft.base;
		},
		get text() {
			reactive.track();
			return draft.text;
		},
		get saving() {
			return reactive.saving;
		},
		change(current, text) {
			draft.change(current, text);
			reactive.changed();
		},
		changedElsewhere(current) {
			reactive.track();
			return draft.changedElsewhere(current);
		},
		discard() {
			draft.discard();
			reactive.changed();
		},
		save: reactive.save,
	};
}
