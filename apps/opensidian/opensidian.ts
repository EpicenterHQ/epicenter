/**
 * Opensidian workspace contract: id, branded types, tables, base actions, and
 * per-row child document models. Isomorphic: no IndexedDB, WebSockets, Svelte
 * state, browser shell APIs, or daemon process lifecycle.
 *
 * Distribution: `apps/opensidian/package.json` exports this file as the
 * `opensidian` package root. Browser code and tests import from here. The table
 * shapes here are the wire contract for sync; forking a
 * column shape breaks sync compatibility with peers running the canonical
 * schema.
 *
 * Composition lives elsewhere:
 *  - `apps/opensidian/opensidian.browser.ts` -> `openOpensidianBrowser(...)`
 */

import { filesTable } from '@epicenter/filesystem';
import {
	defineActions,
	defineWorkspace,
	type WorkspaceFromDefinition,
} from '@epicenter/workspace';

/**
 * Opensidian's shared workspace definition.
 *
 * Defines the filesystem-backed notes table and its per-file content documents.
 *
 * Runtime openers attach persistence, sync, browser services, materializers,
 * and UI state around this shared model.
 */
export const opensidianWorkspace = defineWorkspace({
	id: 'epicenter-opensidian',
	name: 'opensidian',
	tables: {
		files: filesTable,
	},
	kv: {},
	actions: () => defineActions({}),
});
export type OpensidianWorkspace = WorkspaceFromDefinition<
	typeof opensidianWorkspace
>;
