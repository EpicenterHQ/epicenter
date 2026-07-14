/**
 * Reactive folder state for Honeycrisp.
 *
 * Manages async folder mutations and the reactive SQLite projection. Clears
 * URL search param selections when the active folder is deleted.
 *
 * @example
 * ```svelte
 * <script>
 *   import { honeycrisp } from '$lib/honeycrisp';
 * </script>
 *
 * {#each honeycrisp.state.folders.all as folder (folder.id)}
 *   <p>{folder.name}</p>
 * {/each}
 * <button onclick={() => honeycrisp.state.folders.create()}>New Folder</button>
 * ```
 */

import type { FolderId } from '@epicenter/honeycrisp';
import { fromTable } from '@epicenter/svelte';
import type { HoneycrispBrowser } from '$lib/workspace/browser';
import { searchParams } from './search-params.svelte';

export function createFolders(honeycrisp: HoneycrispBrowser) {
	// ─── Reactive State ──────────────────────────────────────────────────

	const foldersView = fromTable(honeycrisp.tables.folders);

	const all = $derived(foldersView.all);

	// ─── Public API ──────────────────────────────────────────────────────

	return {
		whenReady: foldersView.whenReady,
		/**
		 * Look up a folder by ID. Returns `undefined` if not found.
		 */
		get(id: FolderId) {
			return foldersView.byId(id);
		},

		get all() {
			return all;
		},

		/**
		 * Create a new folder with the default name "New Folder".
		 *
		 * The folder is added to the end of the folder list and can be renamed
		 * immediately. Use this when the user clicks "New Folder" in the sidebar.
		 *
		 * @example
		 * ```typescript
		 * app.state.folders.create();
		 * // Folder appears in sidebar with name "New Folder"
		 * ```
		 */
		async create() {
			await honeycrisp.tables.folders.create({
				name: 'New Folder',
				icon: null,
				sortOrder: foldersView.all.length,
			});
		},

		/**
		 * Rename an existing folder.
		 *
		 * Updates the folder name in the sidebar and all references. The folder
		 * must exist; if it doesn't, the update is silently ignored.
		 *
		 * @example
		 * ```typescript
		 * app.state.folders.rename(folderId, 'Work');
		 * ```
		 */
		rename(folderId: FolderId, name: string) {
			void honeycrisp.tables.folders
				.patch(folderId, { name })
				.catch(reportError);
		},

		/**
		 * Delete a folder and move all its notes to unfiled.
		 *
		 * The folder is removed from the sidebar. All notes that were in this
		 * folder are moved to the unfiled section (`folderId` set to `null`).
		 * If the deleted folder was selected, the folder and note selections are cleared.
		 *
		 * Calls the runtime action directly. It commits the folder removal and note
		 * patches as one SQLite workspace mutation.
		 *
		 * @example
		 * ```typescript
		 * app.state.folders.delete(folderId);
		 * // Folder disappears from sidebar, its notes move to "All Notes"
		 * ```
		 */
		delete(folderId: FolderId) {
			void honeycrisp.actions.folders_delete({ folderId }).catch(reportError);
			if (searchParams.folder === folderId) {
				searchParams.update({ folder: null, note: null });
			}
		},
		[Symbol.dispose]() {
			foldersView[Symbol.dispose]();
		},
	};
}
