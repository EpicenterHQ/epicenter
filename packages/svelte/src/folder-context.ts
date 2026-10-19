/**
 * A local folder (`openFolder({ tables })`) as a page's components read and
 * write it: the handle, the page's one query client over its rows, its
 * edit layer, whether everything typed is saved, and one close.
 *
 * `<FolderApp>` opens the folder, builds this, provides it to its
 * children (`getFolder()`), and closes it when the page goes away. A
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
import type { FolderStatus, Folder, Row } from '@epicenter/folder';
import { QueryClient } from '@tanstack/query-core';
import { createContext } from 'svelte';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import {
	createEdits,
	type Edits,
	type Unsaved,
} from './edits.svelte.js';

const log = createLogger('svelte/folder');

/** The root of every query over the folder. */
const KEY = ['folder'] as const;

/**
 * Whether what the person did is in this device's storage. `saved` only when
 * no typing is held, no save runs, and no failure is outstanding.
 */
export type SaveState = 'saved' | 'saving' | 'failed' | 'recent-failure';

/** App-owned file work that must settle before the folder handle closes. */
export type FolderWork = {
	readonly busy: boolean;
	readonly failed: boolean;
	settle(): Promise<unknown>;
};

export function createFolderContext<
	TTables extends Record<string, TSchema>,
>(folder: Folder<TTables>, { saveAfterMs }: { saveAfterMs?: number } = {}) {
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
	const edits: Edits<TTables> = createEdits({
		folder,
		queryClient,
		rowsKey,
		saveAfterMs,
	});
	const work = new Set<FolderWork>();
	const actions = new SvelteSet<Promise<unknown>>();
	let closing: Promise<Unsaved[]> | undefined;

	async function settleWork() {
		const results = await Promise.allSettled([
			...[...work].map((item) => item.settle()),
			...actions,
		]);
		for (const result of results)
			if (result.status === 'rejected')
				log.error(
					new Error('Folder work did not settle', { cause: result.reason }),
				);
	}

	return {
		folder,
		queryClient,
		edits,
		/** Keep an app's file action or text draft in this handle's lifetime. */
		registerWork(item: FolderWork) {
			if (closing !== undefined) throw new Error('The folder is closing');
			work.add(item);
		},
		/** Count a started file action in this handle's close and save status. */
		run<T>(action: () => Promise<T>): Promise<T> {
			if (closing !== undefined)
				return Promise.reject(new Error('The folder is closing'));
			const result = Promise.resolve()
				.then(action)
				.finally(() => actions.delete(result));
			actions.add(result);
			return result;
		},
		/** Send row drafts and app-owned file work while the page is hidden. */
		async settled() {
			await Promise.all([edits.settled(), settleWork()]);
		},
		/** The query options of each read; a view adds `select` to narrow one. */
		queries: {
			key: KEY,
			/** Every row of `table`, each with its source, fields, and issues. */
			rows<TName extends keyof TTables & string>(table: TName) {
				return {
					queryKey: rowsKey(table),
					queryFn: async (): Promise<Row<TTables[TName]>[]> => {
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
			return (
				edits.busy ||
				folder.status.saving ||
				actions.size > 0 ||
				[...work].some((item) => item.busy)
			);
		},
		/** Whether everything is saved on this device, read reactively. */
		get saveState(): SaveState {
			trackStatus();
			if (edits.failures.length > 0 || [...work].some((item) => item.failed))
				return 'failed';
			if (
				edits.busy ||
				folder.status.saving ||
				actions.size > 0 ||
				[...work].some((item) => item.busy)
			)
				return 'saving';
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
				// `edits.close` fences new input synchronously; app work already
				// started can then finish before the handle closes.
				const rowSettling = edits.close();
				await settleWork();
				const unsaved = await rowSettling;
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

export type FolderContext<
	TTables extends Record<string, TSchema> = Record<string, TSchema>,
> = ReturnType<typeof createFolderContext<TTables>>;

const [getContext, setContext] = createContext<FolderContext>();

/**
 * The local folder of the `<FolderApp>` this component is inside, typed
 * by the app's tables. Call it while the component initializes.
 */
export function getFolder<
	TTables extends Record<string, TSchema>,
>(): FolderContext<TTables> {
	return getContext() as unknown as FolderContext<TTables>;
}

/** Provide `context` to this component's subtree. */
export function setFolder<TTables extends Record<string, TSchema>>(
	context: FolderContext<TTables>,
): void {
	setContext(context as unknown as FolderContext);
}
