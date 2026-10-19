/**
 * A local folder (`openFolder({ tables })`) as a page's components read and
 * write it: the handle, the page's one query client over its rows, its
 * edit layer, whether everything typed is saved, and one close.
 *
 * `<LocalFolderApp>` opens the folder, builds this, provides it to its
 * children (`getLocalFolder()`), and closes it when the page goes away. A
 * test builds it over a folder it opened.
 *
 * The context owns every subscription it makes: the folder's change channel
 * marks the rows it names stale, and nothing else reads again. `close`
 * settles the edits, stops that channel, cancels reads, closes the handle,
 * and clears the cache, in that order.
 *
 * Plain module, so a store imports the types without loading components; the
 * edit layer it builds is a runes module.
 */
import type { FolderStatus, Folder, LocalRow } from '@epicenter/folder';
import { QueryClient } from '@tanstack/query-core';
import { createContext } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import {
	createLocalEdits,
	type LocalEdits,
	type Unsaved,
} from './local-edits.svelte.js';

const log = createLogger('svelte/local-folder');

/** The root of every query over the folder. */
const KEY = ['local-folder'] as const;

/**
 * Whether what the person did is in this device's storage. `saved` only when
 * no typing is held, no save runs, and no failure is outstanding.
 */
export type SaveState = 'saved' | 'saving' | 'failed' | 'recent-failure';

export function createLocalFolderContext<
	TTables extends Record<string, TSchema>,
>(
	folder: Folder<TTables>,
	{ saveAfterMs }: { saveAfterMs?: number } = {},
) {
	// Reads reach this device's storage, not a network, and the change
	// channel is the one detector of outside change: a read is fresh until it
	// reports one, and a failure is shown, not retried.
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
	const rowsKey = (table: string) => [...KEY, 'rows', table] as const;

	// Wired before anything reads, so no change falls between.
	const stopChanges = folder.onChange((change) => {
		if (change.paths === null) {
			void queryClient.invalidateQueries({ queryKey: KEY });
			return;
		}
		// A table is a path's first segment; a root file names none.
		const tables = new Set(
			change.paths.map((path) => path.slice(0, Math.max(path.indexOf('/'), 0))),
		);
		for (const table of tables)
			if (Object.hasOwn(folder.tables, table))
				void queryClient.invalidateQueries({ queryKey: rowsKey(table) });
	});
	let closed = false;
	const trackStatus = createSubscriber((update) =>
		closed ? () => {} : folder.onStatusChange(update),
	);
	const edits: LocalEdits<TTables> = createLocalEdits({
		folder,
		queryClient,
		rowsKey,
		saveAfterMs,
	});
	let closing: Promise<Unsaved[]> | undefined;

	return {
		folder,
		queryClient,
		edits,
		/** The query options of each read; a view adds `select` to narrow one. */
		queries: {
			key: KEY,
			/** Every row of `table`, each with its source, fields, and issues. */
			rows<TName extends keyof TTables & string>(table: TName) {
				return {
					queryKey: rowsKey(table),
					queryFn: async (): Promise<LocalRow<TTables[TName]>[]> => {
						const listed = await folder.tables[table].list();
						if (listed.error !== null) throw listed.error;
						return listed.data;
					},
				};
			},
		},
		/** The handle's save status, read reactively. */
		get status(): FolderStatus {
			trackStatus();
			return folder.status;
		},
		/**
		 * Whether leaving the page now could lose something: typing held, or a
		 * save or delete still running, read reactively.
		 */
		get busy(): boolean {
			trackStatus();
			return edits.busy || folder.status.saving;
		},
		/** Whether everything is saved on this device, read reactively. */
		get saveState(): SaveState {
			trackStatus();
			if (edits.failures.length > 0) return 'failed';
			if (edits.busy || folder.status.saving) return 'saving';
			if (folder.status.storageFailure !== null) return 'recent-failure';
			return 'saved';
		},
		/**
		 * Settle the edits, then stop listening, cancel reads, and close the
		 * handle. Answers the drafts that did not save, which are also logged.
		 * Every call answers the same completion.
		 */
		close(): Promise<Unsaved[]> {
			closing ??= (async () => {
				const unsaved = await edits.close();
				for (const draft of unsaved)
					log.warn(
						new Error(
							`Closed with ${draft.table}/${draft.id} unsaved: ${draft.error?.message ?? 'not sent'}`,
						),
					);
				stopChanges();
				closed = true;
				await queryClient.cancelQueries({ queryKey: KEY });
				await folder.close();
				queryClient.unmount();
				queryClient.clear();
				return unsaved;
			})();
			return closing;
		},
	};
}

export type LocalFolderContext<
	TTables extends Record<string, TSchema> = Record<string, TSchema>,
> = ReturnType<typeof createLocalFolderContext<TTables>>;

const [getContext, setContext] = createContext<LocalFolderContext>();

/**
 * The local folder of the `<LocalFolderApp>` this component is inside, typed
 * by the app's tables. Call it while the component initializes.
 */
export function getLocalFolder<
	TTables extends Record<string, TSchema>,
>(): LocalFolderContext<TTables> {
	return getContext() as unknown as LocalFolderContext<TTables>;
}

/** Provide `context` to this component's subtree. */
export function setLocalFolder<TTables extends Record<string, TSchema>>(
	context: LocalFolderContext<TTables>,
): void {
	setContext(context as unknown as LocalFolderContext);
}
