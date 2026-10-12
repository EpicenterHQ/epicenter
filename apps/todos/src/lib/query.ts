/**
 * The one query cache Todos keeps (ADR-0528): the files it shows, and every
 * write and action. Created at import, because nothing about it is async;
 * the folder it reads is opened later, by the page.
 *
 * It comes from `@tanstack/query-core`, the build `@tanstack/svelte-query`
 * re-exports, so the layout's provider and Bun's tests share this one client.
 */
import { type MutationFilters, QueryClient } from '@tanstack/query-core';
import { createQueryFactories, defineKeys } from 'wellcrafted/query';

/** Cache identity for every query and mutation the app runs. */
export const todosKeys = defineKeys({
	/** Every query the app keeps; invalidated after sync, Apply, and recovery. */
	all: ['todos'],
	rows: ['todos', 'rows'],
	files: ['todos', 'files'],
	status: ['todos', 'status'],
	text: (path: string) => ['todos', 'text', path] as const,
	/** Every write of a row or a file's text. */
	writes: ['todos', 'write'],
	write: (path: string) => ['todos', 'write', 'row', path] as const,
	writeText: (path: string) => ['todos', 'write', 'text', path] as const,
	move: (path: string) => ['todos', 'move', path] as const,
	remove: (path: string) => ['todos', 'remove', path] as const,
});

export const queryClient = new QueryClient({
	defaultOptions: {
		// Every read is local: nothing waits for a network, and a file that
		// does not read will not read on a retry either, so a failure shows at
		// once. Nothing goes stale on its own: the cache holds edits on their
		// way to disk, so a view that mounts shows the cache instead of reading
		// over it. Returning to the window reads again, but not while a write
		// runs: the last write to settle reads everything again.
		queries: {
			networkMode: 'always',
			retry: false,
			staleTime: Number.POSITIVE_INFINITY,
			refetchOnWindowFocus: () => (writing() ? false : 'always'),
		},
		// Mutations never retry by default.
		mutations: { networkMode: 'always' },
	},
});

export const { defineMutation } = createQueryFactories(queryClient);

/** Whether a write of a row or a file's text is running or waiting. */
export const writing = (): boolean =>
	queryClient.isMutating({ mutationKey: todosKeys.writes }) > 0;

/**
 * Resolves once nothing matching `filters` is mutating. It watches the
 * mutation cache, so a mutation that starts meanwhile is waited for too.
 */
export function whenIdle(filters?: MutationFilters): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(check);
		function check() {
			if (queryClient.isMutating(filters) > 0) return;
			unsubscribe();
			resolve();
		}
		check();
	});
}
