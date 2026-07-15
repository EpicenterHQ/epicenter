/**
 * Tab Manager's wiring of the shared first-sign-in migration
 * (`@epicenter/app-shell/sign-in-migration`): the local-source opener and the
 * words are app-side; the probe, Add, Delete, Keep, and derived child-doc
 * phases are the kit's.
 *
 * Unlike Honeycrisp's static singleton, this is a factory
 * (`createTabManagerSignInMigration`), not a module-level `export const`:
 * the auth client and the live workspace bundle are both deferred-init
 * behind async `chrome.storage.local` (see `$lib/session.svelte.ts`), so
 * there is no synchronous `auth` or `tabManager` to close over at module
 * load. `session.svelte.ts` calls this once, right after it builds the
 * workspace bundle.
 */

import { createSignInMigration } from '@epicenter/app-shell/sign-in-migration';
import type { AuthClient } from '@epicenter/auth';
import { attachIndexedDb } from '@epicenter/workspace';
import type { TabManagerBundle } from '$lib/session.svelte';
import { tabManagerWorkspace } from '$lib/workspace/definition';

/**
 * Open a throwaway handle to the signed-out plaintext local doc (the
 * migration source). This opens the same `epicenter-tab-manager` IndexedDB
 * the signed-out extension uses; the principal doc's storage is partitioned, so
 * this never collides with the active synced doc. `dispose()` tears down the
 * connection without deleting data (`clearLocal` does the deletion).
 *
 * Only the rows a person actually creates are staged for copy. `toolTrust` is
 * a small local preference, so it is left out of the copy set. Add still
 * clears the whole bare root afterward (`idb.clearLocal` has no per-table
 * granularity), so local tool-trust rows are dropped too.
 */
function openLocalSource() {
	const workspace = tabManagerWorkspace.create();
	const idb = attachIndexedDb(workspace.ydoc);
	return {
		tables: {
			savedTabs: workspace.tables.savedTabs,
			bookmarks: workspace.tables.bookmarks,
			conversations: workspace.tables.conversations,
		},
		whenLoaded: idb.whenLoaded,
		clearLocal: idb.clearLocal,
		dispose: () => workspace.ydoc.destroy(),
	};
}

/**
 * Oxford-comma join for the dialog summary line: `["3 tabs"]` -> "3 tabs",
 * `["3 tabs", "2 bookmarks"]` -> "3 tabs and 2 bookmarks",
 * `["3 tabs", "2 bookmarks", "1 conversation"]` -> "3 tabs, 2 bookmarks, and
 * 1 conversation".
 */
function joinPhrase(parts: string[]): string {
	if (parts.length <= 1) return parts[0] ?? 'data';
	if (parts.length === 2) return parts.join(' and ');
	return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

/**
 * Human phrase for what is staged locally, e.g. "3 tabs", "2 bookmarks", or
 * "3 tabs, 2 bookmarks, and 1 conversation".
 */
function describeLocalContents(counts: Record<string, number>): string {
	const parts: string[] = [];
	const tabs = counts.savedTabs ?? 0;
	if (tabs > 0) parts.push(`${tabs} tab${tabs === 1 ? '' : 's'}`);
	const bookmarks = counts.bookmarks ?? 0;
	if (bookmarks > 0)
		parts.push(`${bookmarks} bookmark${bookmarks === 1 ? '' : 's'}`);
	const conversations = counts.conversations ?? 0;
	if (conversations > 0)
		parts.push(
			`${conversations} conversation${conversations === 1 ? '' : 's'}`,
		);
	return parts.length > 0 ? joinPhrase(parts) : 'data';
}

/**
 * Build the sign-in migration state for one boot. `session.svelte.ts` calls
 * this exactly once, right after `auth` and `tabManager` both exist.
 */
export function createTabManagerSignInMigration(
	auth: AuthClient,
	tabManager: TabManagerBundle,
) {
	return createSignInMigration({
		auth,
		openLocalSource,
		target: tabManager,
		describe: describeLocalContents,
		errorNoun: 'tabs and bookmarks',
	});
}
