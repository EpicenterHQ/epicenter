/**
 * Test helper: TanStack Query for tests that drive the Todos store without
 * mounting components.
 *
 * Tests use the app's one `queryClient`, mounted here as the layout's
 * provider mounts it, so it hears window focus. It and `svelte-query` come
 * from the same `@tanstack/query-core`: the catalog pins it to the exact
 * version `svelte-query` depends on, so the install holds one copy and a
 * mounted test shares every class and manager. Change the two pins together.
 * `clearQueryClient` empties it between tests.
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
	QueryObserver,
} from '@tanstack/query-core';
import type { TodoFields } from './definition.js';
import { queryClient } from './query.js';
import type { TodoListing, Todos } from './todos.svelte.js';

export { focusManager, QueryObserver };

queryClient.mount();

/** Forget every query and mutation, after a test's store has closed. */
export function clearQueryClient() {
	queryClient.clear();
}

/** Run one mutation from `options`, as `createMutation`'s `mutate` does. */
export function mutate<TData, TError>(
	options: MutationOptions<TData, TError, void, unknown>,
): Promise<unknown> {
	return new MutationObserver(queryClient, options)
		.mutate()
		.catch(() => undefined);
}

/** What a view that edits the todo at `stem` does with each change: edit the cache, then queue a write if needed. */
export function rowEditor(todos: Todos, stem: string) {
	const options = todos.rowWrite(stem);
	return (change: (row: Row<TodoFields>) => Row<TodoFields>) => {
		if (todos.edit(stem, change)) void mutate(options);
	};
}

/** What a view showing the text of `path` does with each keystroke. */
export function textEditor(todos: Todos, path: string) {
	const options = todos.textWrite(path);
	return (text: string) => {
		if (todos.editText(path, text)) void mutate(options);
	};
}

/**
 * Observe the queries the open screens show, so invalidation reads them
 * again as it does in the app. Returns the function that stops observing.
 */
export function observe(todos: Todos, ...paths: string[]) {
	const observers = [
		new QueryObserver(queryClient, todos.rowsQuery()),
		new QueryObserver(queryClient, todos.filesQuery()),
		...paths.map(
			(path) => new QueryObserver(queryClient, todos.textQuery(path)),
		),
	];
	const stops = observers.map((observer) => observer.subscribe(() => {}));
	return () => {
		for (const stop of stops) stop();
	};
}

/** Wait until nothing is mutating or fetching. */
export async function quiet() {
	const client = queryClient;
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
export function listing(): TodoListing {
	const data = queryClient.getQueryData<TodoListing>(['todos', 'rows']);
	if (data === undefined) throw new Error('The todo listing is not loaded');
	return data;
}

/** The row the cache holds for `stem`, which must read as a todo. */
export function cached(stem: string): StoredRow<TodoFields> {
	const result = listing().find((entry) => entry.stem === stem)?.result;
	if (result?.error !== null || result === undefined)
		throw new Error(`No valid row for ${stem} in the cache`);
	return result.data;
}
