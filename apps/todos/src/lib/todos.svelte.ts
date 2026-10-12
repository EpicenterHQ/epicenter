/**
 * The Todos store over one opened folder, kept in its own TanStack Query
 * cache (ADR-0528). This file builds the session every part shares: the
 * query client and its rules, what the detail shows, and leaving and
 * closing. The parts are namespaces over that session, each in its file:
 *
 * - `todos.rows`  (`rows.ts`): the todo listing, edits, writes, adding
 * - `todos.files` (`files.ts`): files as listed and as text, create, rename, delete
 * - `todos.git`   (`git.ts`): history state and status, Save version, recovery
 * - `todos.sync`  (`sync.ts`): Sync and its review's Apply
 *
 * Every query and mutation is a wellcrafted definition: a view passes
 * `.options` to `createQuery` or `createMutation`; code and tests call a
 * mutation or `.fetch()` a query and get a `Result`. Saves never commit
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
import { createSubscriber } from 'svelte/reactivity';
import { createQueryFactories } from 'wellcrafted/query';
import { Ok } from 'wellcrafted/result';
import { createFiles } from './files.js';
import { createGit } from './git.js';
import type { TodosFolder } from './platform/types.js';
import { createRows } from './rows.js';
import {
	DEPARTING,
	type Selection,
	type Session,
	TodosError,
	todosKeys,
	type WriteFailure,
} from './session.js';
import { createSync } from './sync.js';
import { createTerminalSession } from './terminal.svelte.js';

export type Todos = ReturnType<typeof createTodos>;

/** How the store reports to the page. */
type TodosOptions = {
	/** A write failed and was rolled back; the app tells the person. */
	onWriteFailed?: (failure: WriteFailure) => void;
};

/**
 * The store of the folder a view belongs to. `FolderScope` sets it for its
 * subtree, with the store's query client; a component calls `getTodos()`
 * while it initializes. Each opened folder has its own scope.
 */
export const [getTodos, setTodos] = createContext<Todos>();

/** The store over one opened folder. Its query client and state live as long as the folder. */
export function createTodos(
	folder: TodosFolder,
	{ onWriteFailed = () => {} }: TodosOptions = {},
) {
	/** What the detail shows. */
	let selected = $state.raw<Selection | undefined>();
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

	// The cache for this folder: the files it shows, and every write and
	// action. Its rules read the mutation cache, which exists first, so the
	// client never refers to itself.
	const mutationCache = new MutationCache();

	/** Whether a write of a row or a file's text is running or waiting. */
	const writing = () =>
		mutationCache.findAll({ mutationKey: todosKeys.writes, status: 'pending' })
			.length > 0;

	const queryClient = new QueryClient({
		mutationCache,
		defaultOptions: {
			// Every read is local: nothing waits for a network, and a file that
			// does not read will not read on a retry either, so a failure shows
			// at once. Nothing goes stale on its own: the cache holds edits on
			// their way to disk, so a view that mounts shows the cache instead of
			// reading over it. Returning to the page reads again, but not while a
			// write runs: the last write to settle reads everything again.
			queries: {
				networkMode: 'always',
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
				refetchOnWindowFocus: () => (writing() ? false : 'always'),
			},
			mutations: {
				networkMode: 'always',
				// While Epicenter asks to leave or Todos closes, no new action
				// starts: TanStack runs `onMutate` when an action is asked for,
				// before its `mutationFn`, and what it throws is the action's
				// error. An action asked for before that runs to the end.
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
	const trackMutations = createSubscriber((update) =>
		mutationCache.subscribe(update),
	);

	// TanStack holds a waiting write until the page is visible, which would
	// stall quitting and lose the write when a background tab closes. So the
	// page counts as always focused, and becoming visible is the focus event
	// that reads again. `focusManager` is one per page and every store sets the
	// same rule, so a second opened folder changes nothing.
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

	/** Resolves once no write of a row or a file's text is running or waiting. */
	const writesSettled = () => whenIdle({ mutationKey: todosKeys.writes });

	/** Whether a rename or delete of `path` is running or waiting, which pauses its edits. */
	const moving = (path: string) =>
		queryClient.isMutating({ mutationKey: todosKeys.move(path), exact: true }) +
			queryClient.isMutating({
				mutationKey: todosKeys.remove(path),
				exact: true,
			}) >
		0;

	/**
	 * Read again what an action may have changed. While a write runs nothing
	 * is read: the last write to settle reads everything again.
	 */
	const invalidate = (queryKey: readonly unknown[] = todosKeys.all) =>
		writing() ? Promise.resolve() : queryClient.invalidateQueries({ queryKey });

	/** After a write settles: once it is the last one, everything is read again. */
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
		trackMutations,
		whenIdle,
		refused,
		moving,
		afterWrite,
		onWriteFailed,
		selection: {
			get current() {
				return selected;
			},
			set(next) {
				selected = next;
			},
		},
	};
	const git = createGit(session);

	const shell = folder.terminal();
	/** A terminal command may write anything, so it is a mutation, and every listing is read again after it. */
	const runCommand = defineMutation({
		mutationKey: ['todos', 'terminal'],
		mutationFn: async ({
			command,
			options,
		}: {
			command: string;
			options?: { signal?: AbortSignal };
		}) => Ok(await shell.exec(command, options)),
		onSettled: () => invalidate(),
	});

	return {
		/** The opened folder; `folder.location` says where the todos are. */
		folder,
		/**
		 * This folder's cache, for `FolderScope`'s `QueryClientProvider` only.
		 * Views read and write through the store, never the client directly:
		 * a read that skips the store's rules can land over unsent edits.
		 */
		queryClient,
		rows: createRows(session),
		files: createFiles(session, git),
		git,
		sync: createSync(session),
		/** The folder's terminal, which outlives its pane. Commands are mutations. */
		terminal: createTerminalSession(
			{
				get cwd() {
					return shell.cwd;
				},
				async exec(command, options) {
					// A command that throws, or is refused, is shown in the terminal's output.
					const ran = await runCommand({ command, options });
					if (ran.data === null) throw ran.error;
					return ran.data;
				},
			},
			() => departing,
		),
		/** Read every listing and open file again, unless a write runs: then the last write reads. */
		refresh: () => invalidate(),
		/** Whether a write of a row or a file's text is running or waiting, read reactively. */
		get saving() {
			trackMutations();
			return writing();
		},
		/** What the detail shows. */
		get selected() {
			return selected;
		},
		/** Show `path` in the detail, as `as` edits it. Opening never waits or asks. */
		select(path: string, as: Selection['as']) {
			selected = { path, as };
		},
		/** Whether Epicenter is asking to quit or restart, which pauses all input. */
		get departing() {
			return departing;
		},
		/**
		 * The page's part in leaving Epicenter
		 * (`@epicenter/epicenter/departure/page`). `fence` runs before anything
		 * is awaited; `settle` waits until nothing is mutating, after which
		 * nothing is lost, so it never asks. `resume` gives everything back.
		 */
		departure: {
			/** Whether leaving now could lose anything: a write or another action still running. */
			get holdsUnsaved() {
				return queryClient.isMutating() > 0;
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
