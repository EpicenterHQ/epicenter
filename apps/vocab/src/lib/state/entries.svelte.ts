/**
 * Reactive entries state: the user-curated entry pool captured by selection.
 *
 * Read straight out of the store. There is no `refresh` and no `await` on a
 * read: `subscribe` says a commit touched the table and fires for a local
 * write and for bytes that arrived from another device alike (ADR-0221), so a
 * re-read after a mutation is something this module hears about rather than
 * something every call site remembers.
 *
 * Bound to the signed-in account's Personal document. The route creates it
 * only after capturing that account, and there is one entry pool per account.
 */

import { InstantString } from '@epicenter/app/field';
import type { Entry, VocabData } from '$lib/data';

export function createEntriesState({ data }: { data: VocabData }) {
	let rows = $state.raw<Entry[]>([]);

	function read(): void {
		rows = data.tables.entries.rows;
	}

	read();
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187).
	const stop = data.tables.entries.subscribe(read);

	/** Every saved entry, newest first. */
	const entries = $derived(
		rows.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
	);

	/** Count of entries marked usable, for the sidebar group label. */
	const usableCount = $derived(
		entries.filter((entry) => entry.stage === 'usable').length,
	);

	/** Apply a change, or throw so the caller's toast can present it. */
	function update(id: string, changes: Partial<Entry>): void {
		const { error } = data.tables.entries.update(id, changes);
		if (error !== null) throw error;
	}

	return {
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
		save(text: string): boolean {
			const trimmed = text.trim();
			if (!trimmed) return false;
			if (entries.some((entry) => entry.text === trimmed)) return false;
			data.tables.entries.create({
				text: trimmed,
				note: '',
				stage: 'new',
				createdAt: InstantString.now(),
			});
			return true;
		},

		/** Change an entry's acquisition stage. */
		setStage(id: string, stage: Entry['stage']) {
			update(id, { stage });
		},

		/** Edit an entry's note. Note is human-owned: only ever written from user edits. */
		setNote(id: string, note: string) {
			update(id, { note });
		},

		/** Remove an entry from the pool. Idempotent over an already-gone row. */
		remove(id: string) {
			data.tables.entries.delete(id);
		},

		[Symbol.dispose]: stop,
	};
}
