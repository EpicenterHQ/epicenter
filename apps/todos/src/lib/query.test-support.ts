/**
 * Test helper: TanStack Query for tests that drive the Todos store without
 * mounting components.
 *
 * Each store owns its query client (`todos.queryClient`). It and
 * `svelte-query` come from the same `@tanstack/query-core`: the catalog pins
 * it to the exact version `svelte-query` depends on, so the install holds one
 * copy and a mounted test shares every class and manager. Change the two pins
 * together.
 *
 * The helpers stand in for what the views do: a screen that shows a query
 * observes it, and a view that edits a todo holds a draft and saves it with
 * its own save mutation. Load this after `svelte-modules.test-support.js`,
 * which compiles the draft's runes module.
 */
import type { FileCapture, Row, StoredRow } from '@epicenter/folder';
import { MutationObserver, QueryObserver } from '@tanstack/query-core';
import type { TodoFields } from './definition.js';
import type { TodoListing } from './todo-listing.js';
import type { Todos } from './todos.svelte.js';

export { QueryObserver };

let createDraftState: typeof import('@epicenter/folder/svelte').createDraftState;
/**
 * Resolves once the draft's runes module is loaded. A test file awaits it at
 * its top level before using `rowEditor`; Bun does not hold this module's
 * importers for a top-level await of a plugin-compiled module.
 */
export const editorsReady = import('@epicenter/folder/svelte').then(
	(module) => {
		createDraftState = module.createDraftState;
	},
);

/**
 * What a view that edits the todo at `stem` does with each change: start or
 * continue its draft from the row the cache holds, then save. Answers the
 * editor, with its draft.
 */
export function rowEditor(todos: Todos, stem: string) {
	const save = new MutationObserver(todos.queryClient, todos.rows.save);
	const draft = createDraftState<TodoFields>({
		save: (sent) => save.mutate(sent),
	});
	const edit = (change: (row: Row<TodoFields>) => Row<TodoFields>) => {
		draft.change(cached(todos, stem), (row) => {
			const next = change(row);
			row.fields = next.fields;
			row.body = next.body;
		});
		void draft.save();
	};
	return Object.assign(edit, { draft });
}

/**
 * Observe the todo listing as the open screens do, so invalidation reads it
 * again as it does in the app. Returns the function that stops observing.
 */
export function observe(todos: Todos) {
	return new QueryObserver(todos.queryClient, todos.rows.todos).subscribe(
		() => {},
	);
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
	const data = todos.queryClient.getQueryData<TodoListing>(
		todos.rows.todos.queryKey,
	);
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

/**
 * The bytes the cache holds for `stem`, a row's or an `InvalidRow`'s, as a
 * view shows them when the person asks to delete it.
 */
export function shown(todos: Todos, stem: string): FileCapture {
	const result = listing(todos).find((entry) => entry.stem === stem)?.result;
	if (result === undefined)
		throw new Error(`No entry for ${stem} in the cache`);
	if (result.error === null)
		return { path: result.data.path, sha256: result.data.sha256 };
	if (result.error.name !== 'InvalidRow')
		throw new Error(`${stem} could not be read: ${result.error.message}`);
	return { path: result.error.path, sha256: result.error.sha256 };
}
