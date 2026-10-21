/**
 * A local folder (`openFolder({ tables })`) as a page's components read and
 * write it: the handle, the page's one query client over its files and rows,
 * whether everything is saved, and one close. The folder owns typed input
 * from the moment it opens (`folder.tables.<name>.edit(id)`,
 * `folder.files.edit(path)`, `folder.getStatus()`, `folder.settle()`,
 * `folder.close()`); this context reads its status reactively and adds what
 * belongs to the page: shared reads, app actions in flight, and the window's close.
 *
 * `<FolderApp>` opens the folder, builds this, and closes it when the page
 * goes away. The app root installs its typed context for descendants to
 * read with `getFolder()`. A test builds it over a folder it opened.
 *
 * Reads after a save have one path: the folder's change channel, which also
 * reports a save of this handle whose content was already stored, marks the
 * queries over the paths it names stale. Visible queries also poll for
 * outside edits. No save or close waits for a reread. `close` refuses new
 * app actions, lets those started finish, stops the channel and cancels
 * reads, closes the folder, and clears the cache, in that order.
 *
 * In the desktop app the context also answers its window's close
 * (`guardWindowClose`) from the folder's current save status.
 *
 * Plain module, so a store imports the types without loading components.
 */
import type { Folder, FolderStatus } from '@epicenter/folder';
import {
	focusManager,
	type InvalidateQueryFilters,
	QueryClient,
} from '@tanstack/query-core';
import { createSubscriber } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { createFolderQueries, folderKeys } from './folder-queries.js';
import { holdWindowClose, reportFolderSaveStatus } from './window-close.js';
import { pendingFailure, type WriteFailure } from './write-failure.js';

const log = createLogger('svelte/folder');

/** The root of every query over the folder. */
const KEY = folderKeys.all;

export function createFolderContext<TTables extends Record<string, TSchema>>(
	folder: Folder<TTables>,
) {
	// Reads reach local storage. Own saves invalidate known paths immediately;
	// outside edits appear on the next visible poll.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				// A second component shares the view's active read.
				refetchOnMount: (query) =>
					query.getObserversCount() > 1 ? true : 'always',
				refetchOnWindowFocus: 'always',
			},
			mutations: { networkMode: 'always', retry: false },
		},
	});
	queryClient.mount();
	const queries = createFolderQueries(folder);
	let closed = false;

	// A refresh must show bytes read after the change. Join an older scan
	// before invalidating, rather than abandoning I/O that cannot be cancelled.
	async function refreshQueries(
		filters: InvalidateQueryFilters,
		options?: { throwOnError?: boolean },
	) {
		if (closed) return;
		await Promise.allSettled(
			queryClient
				.getQueryCache()
				.findAll(filters)
				.map((query) => query.promise),
		);
		if (closed) return;
		// An unobserved old value must not become a recreated file's source.
		// Disabled observers still own their query, so test observer count directly.
		queryClient.removeQueries({
			...filters,
			predicate: (query) =>
				query.queryKey[1] === 'file' &&
				query.getObserversCount() === 0 &&
				(filters.predicate?.(query) ?? true),
		});
		await queryClient.invalidateQueries(filters, {
			...options,
			cancelRefetch: false,
		});
	}

	/**
	 * One batch covers every cached representation and aggregate affected by
	 * a path. A change the folder `reported` is already read by the edits it
	 * touches, so their read queries are left alone then; an asked-for
	 * refresh reads them too.
	 */
	function refreshPaths(
		paths: readonly string[] | undefined,
		options: { throwOnError?: boolean } | undefined,
		reported: boolean,
	) {
		return refreshQueries(
			{
				queryKey: KEY,
				predicate: (query) => {
					const [, kind, target] = query.queryKey;
					if (kind === 'read' && reported) return false;
					if (paths === undefined) return true;
					return paths.some((path) => {
						if (path === '') return true;
						if (kind === 'file' || kind === 'read')
							return (
								typeof target === 'string' &&
								(target === path || target.startsWith(`${path}/`))
							);
						if (kind === 'rows')
							return (
								typeof target === 'string' &&
								(path === target ||
									path.startsWith(`${target}/`) ||
									target.startsWith(`${path}/`))
							);
						// Listings, documents and other aggregates depend on every path.
						return true;
					});
				},
			},
			options,
		);
	}

	const refresh = (
		paths?: readonly string[],
		options?: { throwOnError?: boolean },
	) => refreshPaths(paths, options, false);

	// The one reread path after a save. Subscribe before any reader mounts;
	// applications own no change listeners.
	const stopChanges = folder.onChange((change) => {
		void refreshPaths(change.paths ?? undefined, undefined, true);
	});

	// Svelte shares this subscription across every reactive reader. Context
	// close uses the same update before the Folder itself starts closing.
	let updateStatus: (() => void) | undefined;
	const trackStatus = createSubscriber((update) => {
		updateStatus = update;
		const stop = folder.getStatus().closing
			? () => {}
			: folder.onStatusChange(update);
		return () => {
			updateStatus = undefined;
			stop();
		};
	});
	const actions = new Set<Promise<unknown>>();
	let closing: Promise<WriteFailure[]> | undefined;
	let stopWindow: (() => void) | undefined;
	let guarding: Promise<void> | undefined;

	// One context timer, not one per observer. Query selects active reads and
	// joins any already running. A full scan gets nine times its read duration
	// idle (at least two seconds), limiting repeated scans to roughly 10% duty.
	let refreshTimer = setTimeout(() => void poll(), 2_000);
	async function poll() {
		const started = performance.now();
		try {
			if (focusManager.isFocused())
				await queryClient.refetchQueries(
					{ queryKey: KEY, type: 'active' },
					{ cancelRefetch: false },
				);
		} catch (cause) {
			log.error(new Error('The local folder could not refresh', { cause }));
		} finally {
			if (closing === undefined)
				refreshTimer = setTimeout(
					() => void poll(),
					Math.max(2_000, (performance.now() - started) * 9),
				);
		}
	}

	/** Wait for the app actions started before close and log failures. */
	async function settleActions(): Promise<void> {
		for (const result of await Promise.allSettled([...actions]))
			if (result.status === 'rejected') {
				log.error(
					new Error('A folder action did not finish', { cause: result.reason }),
				);
			}
	}

	/** Only accepted Folder work determines whether departure needs a prompt. */
	const pendingSave = () =>
		folder.getStatus().saving || folder.getStatus().unsaved.length > 0;
	const quitReporter = reportFolderSaveStatus(pendingSave).catch((cause: unknown) => {
		log.error(new Error('Could not report this folder’s save status to Quit', { cause }));
		return () => {};
	});

	return {
		folder,
		queryClient,
		/** Refresh changed paths and their dependents; omit paths to refresh the whole folder. */
		refresh,
		/** Whether close was called: no app action or input is taken from then on. Read reactively. */
		get closing(): boolean {
			trackStatus();
			return closing !== undefined || folder.getStatus().closing;
		},
		/**
		 * Count a started app action in this context's close.
		 * Its own Folder calls, after any await, still run before the folder
		 * closes. Refused once close is called.
		 */
		run<T>(action: () => Promise<T>): Promise<T> {
			if (closing !== undefined)
				return Promise.reject(new Error('The folder is closing'));
			const result = Promise.resolve()
				.then(action)
				.finally(() => actions.delete(result));
			actions.add(result);
			return result;
		},
		/**
		 * In the desktop app, prompt when the folder has an accepted save
		 * pending, then destroy the window on confirmation. A browser tab
		 * keeps its own unload behavior.
		 */
		guardWindowClose(): Promise<void> {
			if (closing !== undefined)
				return Promise.reject(new Error('The folder is closing'));
			guarding ??= Promise.all([
				holdWindowClose(pendingSave),
				quitReporter,
			]).then(([stop]) => {
				if (closing !== undefined) stop();
				else stopWindow = stop;
			});
			return guarding;
		},
		/** Query options include generated keys; apps supply only their read policy. */
		queries,

		/**
		 * The folder's save status, held input included, read reactively: the
		 * one record of whether what the person did is in this device's
		 * storage. App actions are not in it; their writes are, from their
		 * call until they land. A per-file label reads its own edit's
		 * `pending` instead, so another file's failure is never shown as its.
		 */
		getStatus(): FolderStatus {
			trackStatus();
			return folder.getStatus();
		},
		/**
		 * Refuse new app actions, let started ones finish, stop listening and
		 * cancel reads, then close the folder, which sends held input and waits
		 * for its saves. Answers copyable failures for input that did not save,
		 * which are also logged. Every call answers the same completion.
		 */
		close(): Promise<WriteFailure[]> {
			if (closing !== undefined) return closing;
			// Assigned before anything is told, so a listener that closes again
			// answers this same promise.
			const completion = Promise.withResolvers<WriteFailure[]>();
			closing = completion.promise;
			updateStatus?.();
			(async () => {
				clearTimeout(refreshTimer);
				// A window close from here on is the shell's own.
				stopWindow?.();
				(await quitReporter)();
				// An action already started may still call the folder after an
				// await; it finishes before the folder closes.
				await settleActions();
				stopChanges();
				closed = true;
				await queryClient.cancelQueries({ queryKey: KEY });
				const unsaved = (await folder.close()).map(pendingFailure);
				for (const draft of unsaved)
					log.warn(
						new Error(
							`Closed with ${draft.path} unsaved: ${draft.error.message}`,
						),
					);
				queryClient.unmount();
				queryClient.clear();
				return unsaved;
			})().then(completion.resolve, completion.reject);
			return closing;
		},
	};
}

export type FolderContext<
	TTables extends Record<string, TSchema> = Record<string, TSchema>,
> = ReturnType<typeof createFolderContext<TTables>>;
