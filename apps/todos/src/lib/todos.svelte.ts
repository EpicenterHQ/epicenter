/**
 * The Todos store over one opened folder, kept in its own TanStack Query
 * cache (ADR-0528, ADR-0548). Todos shows one folder table: the list is the
 * table, the detail is one row, and an edit is a save of that row's file.
 * Every query comes from the folder's options (`folderOptions`), and the
 * one channel of outside change, `folder.onFilesChanged`, marks what it
 * names stale; nothing rereads on focus.
 *
 * This file builds the session every part shares: the query client and its
 * rules, the change wiring, leaving, and closing. The parts are namespaces
 * over that session, each in its file:
 *
 * - `todos.rows` (`rows.ts`): the todo listing and its views, saving,
 *   adding, and delete
 * - `todos.git`  (`git.ts`): history state and status, Save version
 * - `todos.sync` (`sync.ts`): Sync and its review's Apply
 *
 * A view passes query and mutation options to `createQuery` or
 * `createMutation`. An edit is a draft the editing view holds
 * (`createDraftState`): it keeps the version the edit started from, and
 * `table.save` merges with whatever changed since. Which todo is open is the
 * page URL's (`?todo=<stem>`), not the store's. Saves never commit
 * (ADR-0529); a version is recorded by Sync or by Save version.
 */
import { folderOptions, whenIdle } from '@epicenter/folder/query';
import { QueryClient } from '@tanstack/query-core';
import { createContext } from 'svelte';
import { createQueryFactories } from 'wellcrafted/query';
import { createGit } from './git.js';
import type { TodosFolder } from './platform/types.js';
import { createRows } from './rows.js';
import type { Session, WriteFailure } from './session.js';
import { createSync } from './sync.js';

export type Todos = ReturnType<typeof createTodos>;

/** How the store reports to the page. */
type TodosOptions = {
	/** A save failed; the app tells the person. */
	onWriteFailed?: (failure: WriteFailure) => void;
};

/**
 * The store of the folder a view belongs to. `TodosView` sets it for its
 * subtree, with the store's query client; a component calls `getTodos()`
 * while it initializes.
 */
export const [getTodos, setTodos] = createContext<Todos>();

/** The store over one opened folder. Its query client and state live as long as the folder. */
export function createTodos(
	folder: TodosFolder,
	{ onWriteFailed = () => {} }: TodosOptions = {},
) {
	let closing: Promise<void> | undefined;

	// The cache for this folder: the todo listing, Git status, and every
	// save and action. The folder's options carry their own cache rules;
	// these give Todos' own queries and actions the same ones: local, so
	// nothing waits for a network or retries, and stale only when the
	// folder's change channel, wired below, or a write says so.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: false,
			},
			mutations: { networkMode: 'always' },
		},
	});
	queryClient.mount();
	const { defineQuery, defineMutation } = createQueryFactories(queryClient);
	const folder$ = folderOptions(folder);
	const stopChanges = folder.onFilesChanged((change) =>
		queryClient.invalidateQueries(folder$.pathFilter(change)),
	);

	/** Resolves once no save of a todo's file is running. */
	const writesSettled = () =>
		whenIdle(queryClient, {
			mutationKey: folder$.todos.save.mutationOptions().mutationKey,
		});

	/** Read again what an action may have changed: every query of the folder by default. */
	const invalidate = (queryKey: readonly unknown[] = folder$.key) =>
		queryClient.invalidateQueries({ queryKey });

	const session: Session = {
		folder,
		folder$,
		queryClient,
		defineQuery,
		defineMutation,
		writesSettled,
		invalidate,
		onWriteFailed,
	};

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		/**
		 * This folder's cache, set as svelte-query's client by `TodosView` only.
		 * Views read and write through the store's options.
		 */
		queryClient,
		rows: createRows(session),
		git: createGit(session),
		sync: createSync(session),
		/** Read the listing and Git status again. */
		refresh: () => invalidate(),
		/**
		 * Whether a browser reload now could lose anything: a save or another
		 * action still running. Quitting Epicenter does not ask (ADR-0542).
		 */
		get holdsUnsaved() {
			return queryClient.isMutating() > 0;
		},
		/**
		 * Wait until nothing is mutating, then release the folder. Work that
		 * starts meanwhile is waited for too, so it lands before the folder
		 * closes; after that the folder refuses with `Closed`. Every call
		 * answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closing = (async () => {
				await whenIdle(queryClient);
				stopChanges();
				await queryClient.cancelQueries({ queryKey: folder$.key });
				await folder.close();
				queryClient.unmount();
				queryClient.clear();
			})();
			return closing;
		},
	};
}
