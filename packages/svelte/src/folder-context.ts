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
 * marks the rows it names stale, and nothing else reads again. `close`
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
import type { Folder, FolderStatus, Row } from '@epicenter/folder';
import { QueryClient } from '@tanstack/query-core';
import { createSubscriber, SvelteSet } from 'svelte/reactivity';
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { createEdits, type Edits } from './edits.svelte.js';
import { holdWindowClose } from './window-close.js';
import type { WriteFailure } from './write-failure.js';

const log = createLogger('svelte/folder');

/** The root of every query over the folder. */
const KEY = ['folder'] as const;

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
	const unsent = new Set<() => string | undefined>();
	let closing: Promise<WriteFailure[]> | undefined;
	let stopWindow: (() => void) | undefined;
	let guarding: Promise<void> | undefined;

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
		if (edits.failures.length > 0 || [...work].some((item) => item.failed))
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
		/** Whether leaving this page would discard a draft or explicit form input. */
		get leaving(): boolean {
			return this.busy || [...unsent].some((reason) => reason() !== undefined);
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
		 * handle. Answers copyable failures for drafts that did not save, which
		 * are also logged.
		 * Every call answers the same completion.
		 */
		close(): Promise<WriteFailure[]> {
			closing ??= (async () => {
				// A window close from here on is the shell's own.
				stopWindow?.();
				// `edits.close` fences new input synchronously; app work already
				// started can then finish before the handle closes.
				const rowSettling = edits.close();
				const { files } = await settleWork();
				const missingSave = {
					name: 'Unsaved',
					message: 'The edit did not save.',
				};
				const unsaved: WriteFailure[] = [
					...(await rowSettling).map((draft) => ({
						path: `${draft.table}/${draft.id}.md`,
						error: draft.error ?? missingSave,
						unsaved: JSON.stringify(
							{
								fields: draft.fields,
								...(draft.body === undefined ? {} : { body: draft.body }),
							},
							(_key, value) => (value === undefined ? '[remove field]' : value),
							2,
						),
					})),
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
