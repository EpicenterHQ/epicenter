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
 * `save` is the table's save mutation, as a promise that rejects on failure:
 *
 * ```ts
 * const save = createMutation(() => folder$.todos.save.mutationOptions());
 * const draft = createDraftState<TodoFields>({
 *   save: (sent) => save.mutateAsync(sent),
 * });
 * const shown = $derived(draft.row ?? todo.data?.row);
 * draft.change(todo.data, (row) => { row.fields.title = title; });
 * void draft.save();
 * ```
 *
 * `createTextDraftState({ save })` is the same for one file's exact text,
 * over `createTextDraft()`; `save` is the files' write mutation.
 */
import { createSubscriber } from 'svelte/reactivity';
import {
	createDraft,
	createTextDraft,
	type Draft,
	type SaveTextVariables,
	type TextDraft,
} from '../draft.js';
import type { SaveRowVariables } from '../query.js';
import type { SavedFile } from '../save-file.js';
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
	/** Each save that landed, as for a notice of what it replaced. */
	onSaved?: (saved: SavedRow<TFields>) => void;
}): DraftState<TFields> {
	const draft = createDraft<TFields>();
	const reactive = saveLoop(
		draft,
		({ base, row }) => save({ base, row }),
		onSaved,
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
}: {
	/** Write one save of the text: the files' write mutation, rejecting on failure. */
	save: (sent: SaveTextVariables) => Promise<SavedFile>;
	/** Each save that landed, as for a notice of what it replaced. */
	onSaved?: (saved: SavedFile) => void;
}): TextDraftState {
	const draft = createTextDraft();
	const reactive = saveLoop(
		draft,
		({ base, text }) => save({ base, text }),
		onSaved,
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
