/**
 * Reactive notes state for Honeycrisp.
 *
 * Manages async note mutations and reactive SQLite projections. Rich-text
 * bodies remain separate Yjs child documents. Clears URL search parameters
 * when a selected note is deleted.
 *
 * @example
 * ```svelte
 * <script>
 *   import { honeycrisp } from '$lib/honeycrisp';
 * </script>
 *
 * {#each honeycrisp.state.notes.all as note (note.id)}
 *   <p>{note.title}</p>
 * {/each}
 * <button onclick={() => honeycrisp.state.notes.create(null)}>New Note</button>
 * ```
 */

import { InstantString } from '@epicenter/field';
import type { FolderId, NoteId } from '@epicenter/honeycrisp';
import { fromTable } from '@epicenter/svelte';
import type { HoneycrispBrowser } from '$lib/workspace/browser';
import type { createFolders } from './folders.svelte';
import { searchParams } from './search-params.svelte';

export function createNotes({
	folders,
	honeycrisp,
}: {
	folders: ReturnType<typeof createFolders>;
	honeycrisp: HoneycrispBrowser;
}) {
	// ─── Reactive State ──────────────────────────────────────────────────

	const notesView = fromTable(honeycrisp.tables.notes);

	/** All valid notes (including deleted). Cached, only recomputes when table changes. */
	const allNotes = $derived(notesView.all);

	// ─── Derived State ───────────────────────────────────────────────────

	/** Active notes, not soft-deleted. */
	const all = $derived(allNotes.filter((n) => n.deletedAt === null));

	/** Soft-deleted notes for the Recently Deleted view. */
	const deleted = $derived(allNotes.filter((n) => n.deletedAt !== null));

	/** Per-folder note counts for the sidebar (active notes only). */
	const countsByFolder = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const note of all) {
			if (note.folderId) {
				counts[note.folderId] = (counts[note.folderId] ?? 0) + 1;
			}
		}
		return counts;
	});

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		whenReady: notesView.whenReady,
		/**
		 * Look up a note by ID. Returns `undefined` if not found.
		 */
		get(id: NoteId) {
			return notesView.byId(id);
		},

		get all() {
			return all;
		},
		get deleted() {
			return deleted;
		},
		get countsByFolder() {
			return countsByFolder;
		},

		/**
		 * Create a new note in the given folder and return its ID.
		 *
		 * The note starts with an empty title and preview. Pass a folderId
		 * to file the note, or omit/pass `undefined` to create it unfiled.
		 * The caller is responsible for selecting the note afterward.
		 *
		 * @example
		 * ```typescript
		 * const { id } = app.state.notes.create(app.state.view.selectedFolderId);
		 * app.state.view.selectNote(id);
		 * ```
		 */
		async create(folderId: FolderId | null) {
			const row = await honeycrisp.tables.notes.create({
				folderId,
				title: '',
				preview: '',
				pinned: false,
				deletedAt: null,
				wordCount: null,
				createdAt: InstantString.now(),
				updatedAt: InstantString.now(),
			});
			return { id: row.id };
		},

		/**
		 * Soft-delete a note, moves it to Recently Deleted.
		 *
		 * The note is marked with a `deletedAt` timestamp but not permanently
		 * removed. It can be restored from the Recently Deleted view. If the
		 * deleted note was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.softDelete(noteId);
		 * // Note moves to Recently Deleted, editor closes
		 * ```
		 */
		softDelete(noteId: NoteId) {
			void honeycrisp.tables.notes
				.patch(noteId, { deletedAt: InstantString.now() })
				.catch(reportError);
			if (searchParams.note === noteId) {
				searchParams.update({ note: null });
			}
		},

		/**
		 * Restore a soft-deleted note from Recently Deleted.
		 *
		 * Removes the `deletedAt` timestamp. If the note's original folder no
		 * longer exists, the note is restored to unfiled instead.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.restore(noteId);
		 * // Note reappears in its original folder (or unfiled)
		 * ```
		 */
		restore(noteId: NoteId) {
			const note = notesView.byId(noteId);
			if (!note) return;
			const folderExists = note.folderId
				? folders.all.some((f) => f.id === note.folderId)
				: true;
			void honeycrisp.tables.notes
				.patch(noteId, {
					deletedAt: null,
					...(folderExists ? {} : { folderId: null }),
				})
				.catch(reportError);
		},

		/**
		 * Permanently delete a note, no recovery.
		 *
		 * Removes the note from the database completely. This cannot be undone.
		 * If the deleted note was selected, the selection is cleared.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.permanentlyDelete(noteId);
		 * // Note is removed from Recently Deleted and database
		 * ```
		 */
		permanentlyDelete(noteId: NoteId) {
			void honeycrisp.tables.notes.remove(noteId).catch(reportError);
			if (searchParams.note === noteId) {
				searchParams.update({ note: null });
			}
		},

		/**
		 * Toggle the pin state of a note.
		 *
		 * Pinned notes typically appear at the top of the note list. If the note
		 * doesn't exist, the operation is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.togglePin(noteId);
		 * // Note moves to the top of the list (or unpins)
		 * ```
		 */
		togglePin(noteId: NoteId) {
			const note = notesView.byId(noteId);
			if (!note) return;
			void honeycrisp.tables.notes
				.patch(noteId, { pinned: !note.pinned })
				.catch(reportError);
		},

		/**
		 * Move a note to a different folder.
		 *
		 * Pass `null` to move the note to unfiled (remove from folder).
		 * The note remains selected if it was selected before the move.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.moveToFolder(noteId, folderId);
		 *
		 * // Move a note to unfiled
		 * app.state.notes.moveToFolder(noteId, null);
		 * ```
		 */
		moveToFolder(noteId: NoteId, folderId: FolderId | null) {
			void honeycrisp.tables.notes
				.patch(noteId, { folderId })
				.catch(reportError);
		},

		/**
		 * Update the title, preview, and word count of a note.
		 *
		 * Called when the editor content changes. Caller passes the noteId
		 * explicitly: the note is whichever note the editor is bound to,
		 * which is not necessarily what the URL search param says.
		 *
		 * @example
		 * ```typescript
		 * app.state.notes.updateContent(noteId, {
		 *   title: 'My Note Title',
		 *   preview: 'First line of content...',
		 *   wordCount: 42,
		 * });
		 * ```
		 */
		updateContent(
			noteId: NoteId,
			{
				title,
				preview,
				wordCount,
			}: {
				title: string;
				preview: string;
				wordCount: number;
			},
		) {
			void honeycrisp.tables.notes
				.patch(noteId, { title, preview, wordCount })
				.catch(reportError);
		},

		/** Stamp recency after one local rich-text document update. */
		touch(noteId: NoteId) {
			void honeycrisp.tables.notes
				.patch(noteId, { updatedAt: InstantString.now() })
				.catch(reportError);
		},
		[Symbol.dispose]() {
			notesView[Symbol.dispose]();
		},
	};
}
