/**
 * `@epicenter/folder/svelte`: a draft a component reads reactively
 * (ADR-0548).
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
 */
import { createSubscriber } from 'svelte/reactivity';
import { createDraft, type Draft } from '../draft.js';
import type { SaveRowVariables } from '../query.js';
import type { SavedRow } from '../table.js';

export type DraftState<TFields> = Pick<
	Draft<TFields>,
	'base' | 'row' | 'change' | 'changedElsewhere' | 'discard'
> & {
	/** Whether a save of this draft is running. */
	readonly saving: boolean;
	/**
	 * Save the draft, one save at a time, until no change is left unsent.
	 * Called while a save runs, it resolves when that loop ends. A failed
	 * save ends the loop and keeps the draft; its error is the mutation's.
	 */
	save(): Promise<void>;
};

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
	/** Reads of the draft subscribe; every change to it wakes them. */
	let changed: (() => void) | undefined;
	const track = createSubscriber((update) => {
		changed = update;
		return () => {
			changed = undefined;
		};
	});
	let running: Promise<void> | undefined = $state();

	/** Started only with something to send, so it awaits before it ends. */
	async function loop() {
		try {
			for (let sent = draft.toSave(); sent; sent = draft.toSave()) {
				const saved = await save({ base: sent.base, row: sent.row }).catch(
					() => undefined,
				);
				// The mutation holds the error; the draft keeps the edit.
				if (saved === undefined) return;
				await draft.saved(sent, saved);
				changed?.();
				onSaved?.(saved);
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
		get row() {
			track();
			return draft.row;
		},
		get saving() {
			return running !== undefined;
		},
		change(current, edit) {
			draft.change(current, edit);
			changed?.();
		},
		changedElsewhere(current) {
			track();
			return draft.changedElsewhere(current);
		},
		discard() {
			draft.discard();
			changed?.();
		},
		save() {
			if (running !== undefined) return running;
			if (draft.toSave() === undefined) return Promise.resolve();
			running = loop();
			return running;
		},
	};
}
