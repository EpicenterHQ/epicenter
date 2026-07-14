/**
 * Reactive entries state: the user-curated entry pool captured by selection.
 *
 * Backed by `fromTable()` over the async `entries` table. One app-wide singleton,
 * like `dictation` and `inferenceConnections`: there is one entry pool per
 * workspace, not one per component.
 */

import { InstantString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import type { Entry, EntryId } from '@epicenter/vocab';
import { vocab } from '$lib/vocab';

function createEntriesState() {
	const entriesView = fromTable(vocab.tables.entries);

	/** Every saved entry, newest first. */
	const entries = $derived(
		entriesView.all.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);

	/** Count of entries marked usable, for the sidebar group label. */
	const usableCount = $derived(
		entries.filter((entry) => entry.stage === 'usable').length,
	);

	return {
		/** Resolves after the first SQLite table snapshot reaches the view. */
		whenReady: entriesView.whenReady,
		get entries() {
			return entries;
		},
		get usableCount() {
			return usableCount;
		},

		/**
		 * Save an entry. Saving is explicit: selection capture or the panel
		 * quick-add, never an implicit side effect of reading. Trims and dedupes
		 * by exact text: a repeat save of an already-saved entry is a no-op, not a
		 * duplicate row. `note` starts empty because it is human-owned; no code
		 * path prefills it.
		 */
		async save(text: string): Promise<boolean> {
			const trimmed = text.trim();
			if (!trimmed) return false;
			if (entries.some((entry) => entry.text === trimmed)) return false;
			await vocab.tables.entries.create({
				text: trimmed,
				note: '',
				stage: 'new',
				createdAt: InstantString.now(),
			});
			return true;
		},

		/** Change an entry's acquisition stage. */
		setStage(id: EntryId, stage: Entry['stage']) {
			void vocab.tables.entries.patch(id, { stage }).catch(reportError);
		},

		/** Edit an entry's note. Note is human-owned: only ever written from user edits. */
		setNote(id: EntryId, note: string) {
			void vocab.tables.entries.patch(id, { note }).catch(reportError);
		},

		/** Remove an entry from the pool. */
		remove(id: EntryId) {
			void vocab.tables.entries.remove(id).catch(reportError);
		},
	};
}

export const entriesState = createEntriesState();
