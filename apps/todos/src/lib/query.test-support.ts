/**
 * Test helper: TanStack Query for tests that drive the Todos owner without
 * mounting components.
 *
 * The app imports the query client from `@tanstack/svelte-query`, whose
 * entry also loads `.svelte` components; Bun's server-runtime tests cannot
 * load those. This imports `@tanstack/query-core`, which `svelte-query`
 * re-exports. The catalog pins it to the exact version `svelte-query`
 * depends on, so the install holds one copy and a mounted test that mixes
 * the two shares every class and manager. Change the two pins together.
 *
 * The helpers stand in for what the views do: a screen that shows a query
 * observes it, and a view that edits a file creates its own write mutation
 * and queues a write only when the owner's `edit` says one is needed.
 */
import type { Row, StoredRow } from '@epicenter/folder';
import {
	focusManager,
	MutationObserver,
	type MutationOptions,
	QueryClient,
	QueryObserver,
} from '@tanstack/query-core';
import type { TodoFields } from './definition.js';
import type { TodoListing, Todos } from './todos.svelte.js';

export { focusManager, QueryClient, QueryObserver };

/** A fresh cache, mounted as the layout's provider mounts it, so it hears focus. */
export function createQueryClient() {
	const client = new QueryClient();
	client.mount();
	return client;
}

/** Run one mutation from `options`, as `createMutation`'s `mutate` does. */
export function mutate<TData, TError>(
	todos: Todos,
	options: MutationOptions<TData, TError, void, unknown>,
): Promise<unknown> {
	return new MutationObserver(todos.queryClient, options)
		.mutate()
		.catch(() => undefined);
}

/** What a view that edits the todo at `stem` does with each change: edit the cache, then queue a write if needed. */
export function rowEditor(todos: Todos, stem: string) {
	const options = todos.rowWrite(stem);
	return (change: (row: Row<TodoFields>) => Row<TodoFields>) => {
		if (todos.edit(stem, change)) void mutate(todos, options);
	};
}

/** What a view showing the text of `path` does with each keystroke. */
export function textEditor(todos: Todos, path: string) {
	const options = todos.textWrite(path);
	return (text: string) => {
		if (todos.editText(path, text)) void mutate(todos, options);
	};
}

/**
 * Observe the queries the open screens show, so invalidation reads them
 * again as it does in the app. Returns the function that stops observing.
 */
export function observe(todos: Todos, ...paths: string[]) {
	const observers = [
		new QueryObserver(todos.queryClient, todos.rowsQuery()),
		new QueryObserver(todos.queryClient, todos.filesQuery()),
		...paths.map(
			(path) => new QueryObserver(todos.queryClient, todos.textQuery(path)),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is mutating or fetching. */
export async function quiet(todos: Todos) {
	const client = todos.queryClient;
	for (let tries = 0; tries < 400; tries++) {
		if (client.isMutating() === 0 && client.isFetching() === 0) {
			await Bun.sleep(0);
			if (client.isMutating() === 0 && client.isFetching() === 0) return;
		}
		await Bun.sleep(2);
	}
	throw new Error('The cache did not settle');
}

/** The todo listing the cache holds now. */
export function listing(todos: Todos): TodoListing {
	const data = todos.queryClient.getQueryData<TodoListing>(['todos', 'rows']);
	if (data === undefined) throw new Error('The todo listing is not loaded');
	return data;
}

/** The row the cache holds for `stem`, which must read as a todo. */
export function cached(todos: Todos, stem: string): StoredRow<TodoFields> {
	const result = listing(todos).find((entry) => entry.stem === stem)?.result;
	if (result?.error !== null || result === undefined)
		throw new Error(`No valid row for ${stem} in the cache`);
	return result.data;
}
