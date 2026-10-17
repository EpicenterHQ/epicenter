/**
 * The Todos store over the folder `<FolderApp>` opened (ADR-0548, ADR-0574).
 * Todos shows one folder table: the list is the table, the detail is one
 * row, and an edit is a write of that row's file. Every query comes from
 * the folder's query layer (`queries`), and every write and draft from its
 * edit layer (`edits`); the page's one query client, its change wiring, the
 * write-failure toast, and closing are `<FolderApp>`'s.
 *
 * The store is three parts over the opened folder, each in its file:
 *
 * - `todos.rows` (`rows.ts`): the todo listing and its views, adding, and
 *   delete
 * - `todos.git`  (`git.ts`): history state and status, Save version
 * - `todos.sync` (`sync.ts`): Sync, and connecting to a remote
 *
 * A view passes query and mutation options to `createQuery` or
 * `createMutation`. A field edit is a set of fields on the file as it is
 * now; the notes are the row's body draft (ADR-0576). Which todo is open is
 * the page URL's (`?todo=<stem>`), not the store's. Saves never commit
 * (ADR-0529); a version is recorded by Sync or by Save version.
 */
import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import { createQueryFactories } from 'wellcrafted/query';
import type { todosDefinition } from './definition.js';
import { createGit } from './git.js';
import { createRows } from './rows.js';
import { createSync } from './sync.js';

export type Todos = ReturnType<typeof createTodos>;

/** The opened Todos folder, as `getFolder()` answers it. */
export type TodosFolder = FolderContext<typeof todosDefinition>;

/** What every part of the store is built over: the opened folder, and the rules each follows. */
export type TodosParts = TodosFolder & {
	readonly defineQuery: ReturnType<typeof createQueryFactories>['defineQuery'];
	readonly defineMutation: ReturnType<
		typeof createQueryFactories
	>['defineMutation'];
};

/**
 * The store of the folder a view belongs to. `TodosView` builds it over
 * `getFolder()` and sets it for its subtree; a component calls `getTodos()`
 * while it initializes.
 */
export const [getTodos, setTodos] = createContext<Todos>();

/** The store over the opened folder. It lives as long as the folder's context. */
export function createTodos(opened: TodosFolder) {
	const { folder, queries, queryClient, edits } = opened;
	const parts: TodosParts = {
		...opened,
		...createQueryFactories(queryClient),
	};

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		/** Whether this is Todos's own folder, the only one that offers Connect. */
		isOwn: opened.isOwn,
		/** The page's one query client, which `<FolderApp>` owns. */
		queryClient,
		/** The folder's edit layer: each todo's drafts, sets, and writes. */
		edits,
		rows: createRows(parts),
		git: createGit(parts),
		sync: createSync(parts),
		/** Read the listing and Git status again. */
		refresh: () => queryClient.invalidateQueries({ queryKey: queries.key }),
		/**
		 * Whether a browser reload now could lose anything: text typed and not
		 * saved, or a save or another action still running. Quitting Epicenter
		 * does not ask (ADR-0542).
		 */
		get holdsUnsaved() {
			return edits.busy;
		},
	};
}
