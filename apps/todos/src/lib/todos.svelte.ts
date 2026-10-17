/**
 * The Todos store over the folder `<FolderApp>` opened (ADR-0548, ADR-0574).
 * Todos shows one folder table: the list is the table, the detail is one
 * row, and an edit is a write of that row's file. Every query comes from
 * the folder's query layer (`queries`); the page's one query client, its change
 * wiring, the write-failure toast, and closing are `<FolderApp>`'s.
 *
 * The store is three parts over the opened folder, each in its file:
 *
 * - `todos.rows` (`rows.ts`): the todo listing and its views, writes,
 *   adding, and delete
 * - `todos.git`  (`git.ts`): history state and status, Save version
 * - `todos.sync` (`sync.ts`): Sync and its review's Apply
 *
 * A view passes query and mutation options to `createQuery` or
 * `createMutation`. A field edit is a set of fields on the file as it is
 * now; the notes are a body editor the editing view holds, written as the
 * change from the row it started from (ADR-0576). Which todo is open is the
 * page URL's (`?todo=<stem>`), not the store's. Saves never commit
 * (ADR-0529); a version is recorded by Sync or by Save version.
 */
import { whenIdle } from '@epicenter/folder/query';
import type { FolderContext } from '@epicenter/svelte/folder';
import { partialMatchKey } from '@tanstack/query-core';
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
	/** Resolves once no save of a todo's file is running. */
	readonly writesSettled: () => Promise<void>;
	/** Read `queryKey` again; every query of the folder by default. */
	readonly invalidate: (queryKey?: readonly unknown[]) => Promise<void>;
};

/**
 * The store of the folder a view belongs to. `TodosView` builds it over
 * `getFolder()` and sets it for its subtree; a component calls `getTodos()`
 * while it initializes.
 */
export const [getTodos, setTodos] = createContext<Todos>();

/** The store over the opened folder. It lives as long as the folder's context. */
export function createTodos(opened: TodosFolder) {
	const { folder, queries, queryClient } = opened;
	const { defineQuery, defineMutation } = createQueryFactories(queryClient);

	/** Every write and field set of a todo's file. */
	const rowWrites = [
		queries.todos.write.mutationOptions().mutationKey ?? [],
		queries.todos.set.mutationOptions().mutationKey ?? [],
	];
	const writing = {
		predicate: (mutation: { options: { mutationKey?: readonly unknown[] } }) =>
			rowWrites.some((key) =>
				partialMatchKey(mutation.options.mutationKey ?? [], key),
			),
	};

	/** Read again what an action may have changed: every query of the folder by default. */
	const invalidate = (queryKey: readonly unknown[] = queries.key) =>
		queryClient.invalidateQueries({ queryKey });

	const parts: TodosParts = {
		...opened,
		defineQuery,
		defineMutation,
		writesSettled: () => whenIdle(queryClient, writing),
		invalidate,
	};

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		/** Whether this is Todos's own folder, the only one that offers Connect. */
		isOwn: opened.isOwn,
		/** The page's one query client, which `<FolderApp>` owns. */
		queryClient,
		rows: createRows(parts),
		/** The filter for every write and field set of a todo's file. */
		writing,
		git: createGit(parts),
		sync: createSync(parts),
		/** Read the listing and Git status again. */
		refresh: () => invalidate(),
		/**
		 * Whether a browser reload now could lose anything: a save or another
		 * action still running. Quitting Epicenter does not ask (ADR-0542).
		 */
		get holdsUnsaved() {
			return queryClient.isMutating() > 0;
		},
	};
}
