/**
 * A local folder (`openFolder({ tables })`) as a page's components read and
 * write it: the handle, the page's one query client over its rows, its
 * edit layer, whether everything typed is saved, and one close.
 *
 * `<FolderApp>` opens the folder, builds this, and closes it when the page
 * goes away. The app root installs its typed context for descendants to
 * read with `getFolder()`. A test builds it over a folder it opened.
 *
 * The context owns every subscription it makes: the folder's change channel
 * marks the rows it names stale. Visible queries also poll for outside edits. `close`
 * settles the edits, stops that channel, cancels reads, closes the handle,
 * and clears the cache, in that order.
 *
 * In the desktop app the context also answers its window's close
 * (`guardWindowClose`): what is typed is sent first, without fencing, and
 * the window goes only when nothing would be lost. Input an app holds
 * outside the context, such as a form not submitted, says so through
 * `registerUnsent`.
 *
 * Plain module, so a store imports the types without loading components; the
 * edit layer it builds is a runes module.
 */
import type { Folder, FolderStatus } from '@epicenter/folder';
import {
	focusManager,
	QueryClient,
	type InvalidateQueryFilters,
} from '@tanstack/query-core';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { createEdits, type Edits } from './edits.svelte.js';
import { holdWindowClose } from './window-close.js';
import { createFolderQueries, folderKeys } from './folder-queries.js';
import type { WriteFailure } from './write-failure.js';

const log = createLogger('svelte/folder');

/** The root of every query over the folder. */
const KEY = folderKeys.all;

/** Why the window stays: a draft whose save failed is held. */
const NOT_SAVED =
	'A change did not save. It is still on screen to save again or copy.';
/** Why the window stays: typing or a save arrived while the close was checked. */
const STILL_SAVING =
	'A change is still saving. Close the window again once it is saved.';

/**
 * Whether what the person did is in this device's storage. `saved` only when
 * no typing is held, no save runs, and no failure is outstanding.
 */
export type SaveState = 'saved' | 'saving' | 'failed' | 'recent-failure';

/** Whole-file typing that remained after its owner settled. */
export type UnsavedFile = {
	readonly path: string;
	readonly text: string;
	readonly error?: { readonly name: string; readonly message: string };
};

/** App-owned file work that must settle before the folder handle closes. */
export type FolderWork = {
	readonly busy: boolean;
	readonly failed: boolean;
	settle(): Promise<void | readonly UnsavedFile[]>;
};

export function createFolderContext<TTables extends Record<string, TSchema>>(
	folder: Folder<TTables>,
	{ saveAfterMs }: { saveAfterMs?: number } = {},
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

	// A save must refresh from bytes read after it landed. Join an older scan
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
		// An unobserved old value must not become a recreated file's save base.
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

	// Subscribe before any reader mounts. Applications own no change listeners.
	const stopChanges = folder.onChange((change) => {
		void refresh(change.paths ?? undefined);
	});

	const trackStatus = createSubscriber((update) =>
		closed ? () => {} : folder.onStatusChange(update),
	);
	const edits: Edits<TTables> = createEdits({
		folder,
		refresh,
		saveAfterMs,
	});
	const work = new Set<FolderWork>();
	const actions = new SvelteSet<Promise<unknown>>();
	const unsent = new Set<() => string | undefined>();
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

	async function settleWork(): Promise<{
		files: UnsavedFile[];
		rejected: boolean;
	}> {
		const [owners, actionResults] = await Promise.all([
			Promise.allSettled([...work].map((item) => item.settle())),
			Promise.allSettled([...actions]),
		]);
		const files = owners.flatMap((result) =>
			result.status === 'fulfilled' ? (result.value ?? []) : [],
		);
		let rejected = false;
		for (const result of [...actionResults, ...owners]) {
			if (result.status === 'rejected') {
				rejected = true;
				log.error(
					new Error('Folder work did not settle', { cause: result.reason }),
				);
			}
		}
		return { files, rejected };
	}

	async function settled() {
		const [rows, other] = await Promise.allSettled([
			edits.settled(),
			settleWork(),
		]);
		if (rows.status === 'rejected')
			log.error(
				new Error('Folder row edits did not settle', { cause: rows.reason }),
			);
		if (other.status === 'rejected')
			log.error(
				new Error('Folder work did not settle', { cause: other.reason }),
			);
		return (
			rows.status === 'fulfilled' &&
			rows.value.length === 0 &&
			other.status === 'fulfilled' &&
			other.value.files.length === 0 &&
			!other.value.rejected
		);
	}

	/** Why closing the window now would lose something, once what is typed was sent. */
	async function windowBlockers(): Promise<string[]> {
		const didSettle = await settled();
		const reasons: string[] = [];
		if (!didSettle)
			reasons.push('A save could not finish. Your input is still here.');
		if (
			edits.failures.length > 0 ||
			edits.textFailures.length > 0 ||
			[...work].some((item) => item.failed)
		)
			reasons.push(NOT_SAVED);
		else if (
			edits.busy ||
			folder.status.saving ||
			actions.size > 0 ||
			[...work].some((item) => item.busy)
		)
			reasons.push(STILL_SAVING);
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
		settled,
		/**
		 * Input typed outside this context and not submitted, such as a form
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
		/** Whether leaving this page would discard a draft or explicit form input. */
		get leaving(): boolean {
			return this.busy || [...unsent].some((reason) => reason() !== undefined);
		},
		/** Whether everything is saved on this device, read reactively. */
		get saveState(): SaveState {
			trackStatus();
			if (
				edits.failures.length > 0 ||
				edits.textFailures.length > 0 ||
				[...work].some((item) => item.failed)
			)
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
		 * handle. Answers copyable failures for drafts that did not save, which
		 * are also logged.
		 * Every call answers the same completion.
		 */
		close(): Promise<WriteFailure[]> {
			closing ??= (async () => {
				clearTimeout(refreshTimer);
				// A window close from here on is the shell's own.
				stopWindow?.();
				// `edits.close` fences new input synchronously; app work already
				// started can then finish before the handle closes.
				const editSettling = edits.close();
				const { files } = await settleWork();
				const missingSave = {
					name: 'Unsaved',
					message: 'The edit did not save.',
				};
				const unsaved: WriteFailure[] = [
					...(await editSettling).map((draft) =>
						'path' in draft
							? {
									path: draft.path,
									error: draft.error ?? missingSave,
									unsaved: draft.text,
								}
							: {
									path: `${draft.table}/${draft.id}.md`,
									error: draft.error ?? missingSave,
									unsaved: JSON.stringify(
										{
											fields: draft.fields,
											...(draft.body === undefined ? {} : { body: draft.body }),
										},
										(_key, value) =>
											value === undefined ? '[remove field]' : value,
										2,
									),
								},
					),
					...files.map((draft) => ({
						path: draft.path,
						error: draft.error ?? missingSave,
						unsaved: draft.text,
					})),
				];
				for (const draft of unsaved)
					log.warn(
						new Error(
							`Closed with ${draft.path} unsaved: ${draft.error.message}`,
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
