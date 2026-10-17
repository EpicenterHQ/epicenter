/**
 * The opened folder a folder app's components read and write through
 * (ADR-0574): the handle, its reads, its edit layer, and the one query
 * client and write-failure report the whole page shares.
 *
 * `<FolderApp>` opens the app's folder, builds this with
 * `createFolderContext`, provides it with `<FolderProvider>`, and closes it
 * when the page goes away. A component calls `getFolder()` while it
 * initializes; a test builds the context over a test folder and mounts its
 * views inside `<FolderProvider>`.
 *
 * Plain module: a store imports the types and `createFolderContext` without
 * loading Svelte components.
 */
import type { Definition, Folder } from '@epicenter/folder';
import { type FolderOptions, folderOptions } from '@epicenter/folder/query';
import { QueryClient } from '@tanstack/query-core';
import { createContext } from 'svelte';
import { createEdits, type Edits } from './edits.svelte.js';
import type { WriteFailure } from './write-failure.js';

/** What `getFolder()` answers: one opened folder and the page's cache over it. */
export type FolderContext<TDefinition extends Definition = Definition> = {
	/**
	 * The opened handle. Its own `definition` is the app's in the app's own
	 * folder, and the folder's declaration in any other the desktop handed
	 * the window.
	 */
	readonly folder: Folder<TDefinition, Definition>;
	/**
	 * Whether this is the app's own folder, the one named after it: the
	 * handle's `folder.own`, true exactly when it publishes the app's
	 * definition (ADR-0583). A
	 * feature that belongs to the app's own folder only, such as Todos'
	 * Connect, checks it.
	 */
	readonly isOwn: boolean;
	/**
	 * The TanStack Query layer over the folder: each read's query options
	 * (`folderOptions` in `@epicenter/folder/query`).
	 */
	readonly queries: FolderOptions<TDefinition>;
	/**
	 * Every write of the folder, and what a person typed and has not saved:
	 * drafts, field sets, renames and deletes, Save version, and Sync
	 * (`createEdits` in `@epicenter/svelte/edits`).
	 */
	readonly edits: Edits<Folder<TDefinition, Definition>['tables']>;
	/**
	 * The page's one cache. svelte-query's `useQueryClient()` answers it
	 * inside `<FolderProvider>`; a store built outside a component takes it
	 * from here.
	 */
	readonly queryClient: QueryClient;
	/**
	 * Tell the person a save failed, offering the text it held. Inside
	 * `<FolderApp>` it is one toast for every app.
	 */
	readonly writeFailed: (failure: WriteFailure) => void;
	/**
	 * Fence new input (`edits.close`), wait for every draft, write, and
	 * action, stop the change wiring, then release the folder. Work that
	 * starts meanwhile is waited for too; after that the folder refuses with
	 * `Closed`. Every call answers the same completion.
	 */
	readonly close: () => Promise<void>;
};

/**
 * Build the context over an opened folder: the page's query client with
 * the one policy every folder app shares, the folder's options, and its
 * change channel wired to the cache.
 *
 * The policy: the folder's change channel is the one detector of outside
 * change (ADR-0548), so a read is fresh until it reports one
 * (`staleTime: Infinity`) and is never read again on focus; reads and writes
 * reach files, not a network, so none waits for one (`networkMode:
 * 'always'`); and a failure is shown, not retried (`retry: false`).
 */
export function createFolderContext<TDefinition extends Definition>(
	folder: Folder<TDefinition, Definition>,
	{
		writeFailed = () => {},
	}: {
		/** A save failed. `<FolderApp>` passes its toast; a test, its own record. */
		writeFailed?: (failure: WriteFailure) => void;
	} = {},
): FolderContext<TDefinition> {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: false,
			},
			mutations: { networkMode: 'always', retry: false },
		},
	});
	queryClient.mount();
	const queries = folderOptions(folder) as FolderOptions<TDefinition>;
	// Wired before anything reads, so no change falls between.
	const stopChanges = queries.invalidateOnChange(queryClient);
	const edits = createEdits({ folder, queries, queryClient, writeFailed });
	let closing: Promise<void> | undefined;

	return {
		folder,
		isOwn: folder.own,
		queries,
		edits,
		queryClient,
		writeFailed,
		close() {
			closing ??= (async () => {
				await edits.close();
				stopChanges();
				await queryClient.cancelQueries({ queryKey: queries.key });
				await folder.close();
				queryClient.unmount();
				queryClient.clear();
			})();
			return closing;
		},
	};
}

const [getContext, setContext] = createContext<FolderContext>();

/**
 * The opened folder of the `<FolderApp>` or `<FolderProvider>` this
 * component is inside, typed by the app's definition. Call it while the
 * component initializes.
 */
export function getFolder<
	TDefinition extends Definition = Definition,
>(): FolderContext<TDefinition> {
	return getContext() as unknown as FolderContext<TDefinition>;
}

/** Provide `context` to this component's subtree. `<FolderProvider>` calls it. */
export function setFolder<TDefinition extends Definition>(
	context: FolderContext<TDefinition>,
): void {
	setContext(context as unknown as FolderContext);
}
