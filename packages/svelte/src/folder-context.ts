/**
 * A local folder (`openFolder({ tables })`) as a page's components read and
 * write it: the handle, the page's one query client over its files and rows,
 * whether everything is saved, and one close. The folder owns typed input
 * from the moment it opens (`folder.tables.<name>.edit(id)`,
 * `folder.files.edit(path)`, `folder.getStatus()`, `folder.settle()`,
 * `folder.close()`); this context reads its status reactively and adds what
 * belongs to the page: shared reads, app actions in flight, input a page
 * holds outside the folder, and the window's close.
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
 * (`guardWindowClose`): what is typed is sent first, without fencing, and
 * the window goes only when nothing would be lost. Input an app holds
 * outside the folder, such as a form not submitted, says so through
 * `registerUnsent`.
 *
 * Plain module, so a store imports the types without loading components.
 */
import type { Folder, FolderStatus } from '@epicenter/folder';
import type { Pending } from '@epicenter/folder/edits';
import {
	focusManager,
	type InvalidateQueryFilters,
	QueryClient,
} from '@tanstack/query-core';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { createFolderQueries, folderKeys } from './folder-queries.js';
import { holdWindowClose } from './window-close.js';
import { pendingFailure, type WriteFailure } from './write-failure.js';

const log = createLogger('svelte/folder');

/** The root of every query over the folder. */
const KEY = folderKeys.all;

/** Why the window stays: input whose save failed is held. */
const NOT_SAVED =
	'A change did not save. It is still on screen to save again or copy.';
/** Why the window stays: typing or a save arrived while the close was checked. */
const STILL_SAVING =
	'A change is still saving. Close the window again once it is saved.';

/**
 * Whether what the person did is in this device's storage, from the folder's
 * status alone. `saved` only when no input is held, no save runs, and no
 * failure is outstanding. App actions count in `busy`, not here.
 */
export type SaveState = 'saved' | 'saving' | 'failed' | 'recent-failure';

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

	// One batch covers every cached representation and aggregate affected by a path.
	function refresh(
		paths?: readonly string[],
		options?: { throwOnError?: boolean },
	) {
		return refreshQueries(
			{
				queryKey: KEY,
				predicate: (query) => {
					if (paths === undefined) return true;
					const [, kind, target] = query.queryKey;
					return paths.some((path) => {
						if (path === '') return true;
						if (kind === 'file')
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

	// The one reread path after a save. Subscribe before any reader mounts;
	// applications own no change listeners.
	const stopChanges = folder.onChange((change) => {
		void refresh(change.paths ?? undefined);
	});

	const trackStatus = createSubscriber((update) =>
		folder.getStatus().closing ? () => {} : folder.onStatusChange(update),
	);
	const actions = new SvelteSet<Promise<unknown>>();
	const unsent = new Set<() => string | undefined>();
	let closing: Promise<WriteFailure[]> | undefined;
	const closingListeners = new Set<() => void>();
	const trackClosing = createSubscriber((update) => {
		closingListeners.add(update);
		return () => {
			closingListeners.delete(update);
		};
	});
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

	/** Wait for the app actions started now; answers whether none was rejected. */
	async function settleActions(): Promise<boolean> {
		let rejected = false;
		for (const result of await Promise.allSettled([...actions]))
			if (result.status === 'rejected') {
				rejected = true;
				log.error(
					new Error('A folder action did not finish', { cause: result.reason }),
				);
			}
		return !rejected;
	}

	/** Send held input and wait for app actions, without fencing. Answers whether all of it saved. */
	async function settled(): Promise<boolean> {
		const [unsaved, finished] = await Promise.all([
			folder.getStatus().closing ? Promise.resolve([]) : folder.settle(),
			settleActions(),
		]);
		return unsaved.length === 0 && finished;
	}

	const working = () =>
		folder.getStatus().unsaved.length > 0 ||
		folder.getStatus().saving ||
		actions.size > 0;

	/** Why closing the window now would lose something, once what is typed was sent. */
	async function windowBlockers(): Promise<string[]> {
		const didSettle = await settled();
		const reasons: string[] = [];
		if (!didSettle)
			reasons.push('A save could not finish. Your input is still here.');
		if (folder.getStatus().failures.length > 0) reasons.push(NOT_SAVED);
		else if (working()) reasons.push(STILL_SAVING);
		for (const reason of unsent) {
			const why = reason();
			if (why !== undefined) reasons.push(why);
		}
		return reasons;
	}

	return {
		folder,
		queryClient,
		/** Refresh changed paths and their dependents; omit paths to refresh the whole folder. */
		refresh,
		/**
		 * Input typed through the folder's edit handles whose last save failed
		 * and that no save is retrying, read reactively. Each stays on its
		 * handle to save again, copy, or discard.
		 */
		get failures(): readonly Pending[] {
			trackStatus();
			return folder.getStatus().failures;
		},
		/** Whether close was called: no app action or input is taken from then on. Read reactively. */
		get closing(): boolean {
			trackClosing();
			trackStatus();
			return closing !== undefined || folder.getStatus().closing;
		},
		/**
		 * Count a started app action in this context's busy state and close.
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
		/** Send held input and wait for app actions while the page is hidden. */
		settled,
		/**
		 * Input typed outside the folder and not submitted, such as a form
		 * not added: `reason` says why closing the desktop window now would
		 * lose it, or nothing. Answers the unregister.
		 */
		registerUnsent(reason: () => string | undefined): () => void {
			unsent.add(reason);
			return () => {
				unsent.delete(reason);
			};
		},
		/**
		 * In the desktop app, until `close`: a close of this window first
		 * sends what is typed and waits for the saves, then destroys the
		 * window. A failed save, a save still running, or unsent input keeps
		 * the window with everything on screen, and a notice says why. A
		 * browser tab keeps its own unload behavior.
		 */
		guardWindowClose(): Promise<void> {
			if (closing !== undefined)
				return Promise.reject(new Error('The folder is closing'));
			guarding ??= holdWindowClose(windowBlockers).then((stop) => {
				if (closing !== undefined) stop();
				else stopWindow = stop;
			});
			return guarding;
		},
		/** Query options include generated keys; apps supply only their read policy. */
		queries,

		/** The folder's save status, held input included, read reactively. */
		get status(): FolderStatus {
			trackStatus();
			return folder.getStatus();
		},
		/**
		 * Whether leaving the page now could lose something: input held, or a
		 * save, delete or app action still running, read reactively.
		 */
		get busy(): boolean {
			trackStatus();
			return working();
		},
		/** Whether leaving this page would discard held input or explicit form input. */
		get leaving(): boolean {
			return this.busy || [...unsent].some((reason) => reason() !== undefined);
		},
		/**
		 * Whether everything is saved on this device, read reactively: the
		 * folder's own facts, held input and its saves. An app action that
		 * saves nothing yet, such as a request it waits for, is `busy` but
		 * not `saving`; its writes are, from their call until they land.
		 */
		get saveState(): SaveState {
			trackStatus();
			const { failures, saving, unsaved } = folder.getStatus();
			if (failures.length > 0) return 'failed';
			if (saving || unsaved.length > 0) return 'saving';
			if (folder.getStatus().storageFailure !== null) return 'recent-failure';
			return 'saved';
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
			for (const listener of [...closingListeners]) listener();
			(async () => {
				clearTimeout(refreshTimer);
				// A window close from here on is the shell's own.
				stopWindow?.();
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
