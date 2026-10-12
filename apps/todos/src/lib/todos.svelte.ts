/**
 * The Todos store over one opened folder, kept in its own TanStack Query
 * cache (ADR-0528). Todos shows one folder table: the list is the table, the
 * detail is one row, and a field change is a write of that row's file.
 * Every write carries the hash of the version the person acted on, taken
 * when they acted. The cache holds the listing; the store also holds repair
 * text typed and not saved.
 *
 * This file builds the session every part shares: the query client and its
 * rules, leaving, and closing. The parts are namespaces over that session,
 * each in its file:
 *
 * - `todos.rows` (`rows.ts`): the todo listing and its views, edits, writes,
 *   adding, rename, delete, and repair drafts of a file that does not read
 *   as a todo
 * - `todos.git`  (`git.ts`): history state and status, Save version, recovery
 * - `todos.sync` (`sync.ts`): Sync and its review's Apply
 *
 * Every query and mutation is a wellcrafted definition: a view passes
 * `.options` to `createQuery` or `createMutation`; code and tests call a
 * mutation or `.fetch()` a query and get a `Result`. A member that takes a
 * stem and returns a definition is one a view holds (`rows.entry`,
 * `rows.write`, `rows.repair`); an async method is a one-shot action a
 * handler awaits (`rows.rename`, `rows.remove`). Whether something runs
 * is TanStack's: a view asks `useIsMutating` with a key from `todosKeys`
 * (`writes`, `moving(path)`, `recoverIncoming`). Which todo is open is the
 * page URL's (`?todo=<stem>`), not the store's. Saves never commit
 * (ADR-0529); a version is recorded by Sync or by Save version.
 */
import type { DepartureParticipant } from '@epicenter/epicenter/departure/page';
import {
	focusManager,
	MutationCache,
	type MutationFilters,
	QueryClient,
} from '@tanstack/query-core';
import { createContext } from 'svelte';
import { createQueryFactories } from 'wellcrafted/query';
import { createGit } from './git.js';
import type { TodosFolder } from './platform/types.js';
import { createRows } from './rows.js';
import {
	DEPARTING,
	type Session,
	TodosError,
	todosKeys,
	type WriteFailure,
} from './session.js';
import { createSync } from './sync.js';

export type Todos = ReturnType<typeof createTodos>;

/** How the store reports to the page. */
type TodosOptions = {
	/** A write failed; the app tells the person. */
	onWriteFailed?: (failure: WriteFailure) => void;
};

/**
 * The store of the folder a view belongs to. `FolderScope` sets it for its
 * subtree, with the store's query client; a component calls `getTodos()`
 * while it initializes.
 */
export const [getTodos, setTodos] = createContext<Todos>();

/** The store over one opened folder. Its query client and state live as long as the folder. */
export function createTodos(
	folder: TodosFolder,
	{ onWriteFailed = () => {} }: TodosOptions = {},
) {
	/**
	 * Epicenter asks to quit or restart. From `departure.fence` until
	 * `departure.resume`, no edit or action starts; writes already queued go on.
	 */
	let departing = $state(false);
	let closing: Promise<void> | undefined;

	/** Why no edit or action starts now, if one does not. */
	function refused(): string | undefined {
		return departing ? DEPARTING : undefined;
	}

	// The cache for this folder: the todo listing, Git status, and every
	// write and action. Its rules read the mutation cache, which exists first, so the
	// client never refers to itself.
	const mutationCache = new MutationCache();

	const queryClient = new QueryClient({
		mutationCache,
		defaultOptions: {
			// Every read is local: nothing waits for a network, and a file that
			// does not read will not read on a retry either, so a failure shows
			// at once. The app reads when it opens, when the page is shown
			// again, and after its own actions, so nothing goes stale on its
			// own. A read lands whenever it finishes, even while a write runs
			// (ADR-0528 accepts what that can cost).
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: 'always',
			},
			mutations: {
				networkMode: 'always',
				// While Epicenter asks to leave, no new action starts: TanStack
				// runs `onMutate` when an action is asked for, before its
				// `mutationFn`, and what it throws is the action's error. An
				// action asked for before that runs to the end.
				onMutate: () => {
					const why = refused();
					if (why !== undefined)
						throw TodosError.NotStarted({ reason: why }).error;
				},
			},
		},
	});
	queryClient.mount();
	const { defineQuery, defineMutation } = createQueryFactories(queryClient);

	// TanStack holds a waiting write until the page is visible, which would
	// stall quitting and lose the write when a background tab closes. So the
	// page counts as always focused, and becoming visible is the focus event
	// that reads again. `focusManager` is one per page.
	focusManager.setEventListener((setFocused) => {
		setFocused(true);
		if (typeof document === 'undefined') return undefined;
		const returned = () => {
			if (document.visibilityState === 'visible') focusManager.onFocus();
		};
		document.addEventListener('visibilitychange', returned);
		return () => document.removeEventListener('visibilitychange', returned);
	});

	/**
	 * Resolves once nothing matching `filters` is mutating. It watches the
	 * mutation cache, so a mutation that starts meanwhile is waited for too.
	 */
	function whenIdle(filters?: MutationFilters): Promise<void> {
		return new Promise((resolve) => {
			const unsubscribe = mutationCache.subscribe(check);
			function check() {
				if (queryClient.isMutating(filters) > 0) return;
				unsubscribe();
				resolve();
			}
			check();
		});
	}

	/** Resolves once no write of a todo's file is running or waiting. */
	const writesSettled = () => whenIdle({ mutationKey: todosKeys.writes });

	/** Read again what an action may have changed. */
	const invalidate = (queryKey: readonly unknown[] = todosKeys.all) =>
		queryClient.invalidateQueries({ queryKey });

	/**
	 * After a write settles: once it is the last one, everything is read
	 * again. Not after each write, since Git status reads the whole folder.
	 */
	const afterWrite = () =>
		queryClient.isMutating({ mutationKey: todosKeys.writes }) <= 1
			? queryClient.invalidateQueries({ queryKey: todosKeys.all })
			: undefined;

	const session: Session = {
		folder,
		queryClient,
		defineQuery,
		defineMutation,
		writesSettled,
		invalidate,
		whenIdle,
		refused,
		afterWrite,
		onWriteFailed,
	};

	const rows = createRows(session);

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		/**
		 * This folder's cache, for `FolderScope`'s `QueryClientProvider` only.
		 * Views read and write through the store, never the client directly:
		 * a read that skips the store's rules can land over unsent edits.
		 */
		queryClient,
		rows,
		git: createGit(session),
		sync: createSync(session),
		/** Read the listing and Git status again. */
		refresh: () => invalidate(),
		/** Whether Epicenter is asking to quit or restart, which pauses all input. */
		get departing() {
			return departing;
		},
		/**
		 * The page's part in leaving: Epicenter's quit or restart
		 * (`@epicenter/epicenter/departure/page`), and the browser's leave
		 * warning through the view's `beforeNavigate`. `fence` runs before
		 * anything is awaited; `settle` waits until nothing is mutating, then
		 * answers 0, so Epicenter never asks: Todos has no prompt to show, and
		 * repair text typed and not saved is dropped on quit. `resume` gives
		 * everything back.
		 */
		departure: {
			/**
			 * Whether leaving now could lose anything: a write or another action
			 * still running, or repair text typed and not saved.
			 */
			get holdsUnsaved() {
				return queryClient.isMutating() > 0 || rows.drafted > 0;
			},
			fence() {
				departing = true;
			},
			async settle(): Promise<number> {
				await whenIdle();
				return 0;
			},
			resume() {
				departing = false;
			},
		} satisfies DepartureParticipant,
		/**
		 * Wait until nothing is mutating, then release the folder. Work that
		 * starts meanwhile is waited for too, so it lands before the folder
		 * closes; after that the folder refuses with `Closed`. Every call
		 * answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closing = (async () => {
				await whenIdle();
				await queryClient.cancelQueries({ queryKey: todosKeys.all });
				await folder.close();
				queryClient.unmount();
				queryClient.clear();
			})();
			return closing;
		},
	};
}
