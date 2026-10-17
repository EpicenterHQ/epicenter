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
 * observes it, a title box types into the title's draft and leaves it, the
 * checkbox sets its field at once, and the notes type into the body's draft.
 */
import type { StoredRow } from '@epicenter/folder';
import { QueryObserver } from '@tanstack/query-core';
import type { TodoFields } from './definition.js';
import type { TodoListing } from './todo-listing.js';
import type { Todos } from './todos.svelte.js';

export { QueryObserver };

/**
 * What the detail's controls of the todo at `stem` do with each change: a
 * title is typed into its draft and sent as the person leaves the box, and
 * the checkbox sets its field at once. Each call resolves once its save
 * settled; a failure is the edit layer's to report.
 */
export function rowEditor(todos: Todos, stem: string) {
	return async (fields: Partial<TodoFields>) => {
		const { title, ...rest } = fields;
		const saves: Promise<void>[] = [];
		if (title !== undefined) {
			const draft = todos.edits.field('todos', stem, 'title');
			draft.change(title);
			saves.push(draft.save());
		}
		if (Object.keys(rest).length > 0) {
			todos.edits.set('todos', stem, rest);
			saves.push(todos.edits.settled(`todos/${stem}.md`));
		}
		await Promise.all(saves);
	};
}

/**
 * What the detail's notes do once a pause in typing sends them: type `body`
 * into the todo's body draft and send it.
 */
export function notesEditor(todos: Todos, stem: string) {
	return (body: string) => {
		const notes = todos.edits.body('todos', stem);
		notes.change(body);
		return notes.save();
	};
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

/**
 * Wait until no write runs or waits, and nothing is mutating or fetching.
 * Typing that waits for its pause is not waited for.
 */
export async function quiet(todos: Todos) {
	const client = todos.queryClient;
	const idle = () =>
		todos.edits.writes.pending() === 0 &&
		client.isMutating() === 0 &&
		client.isFetching() === 0;
	for (let tries = 0; tries < 400; tries++) {
		if (idle()) {
			await Bun.sleep(0);
			if (idle()) return;
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
