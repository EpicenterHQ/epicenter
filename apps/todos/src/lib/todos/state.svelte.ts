import type { CalendarDateString } from '@epicenter/field';
import { fromTable } from '@epicenter/svelte';
import {
	BUILT_IN_CONTEXTS,
	type ContextSlug,
	type Todo,
	type TodoId,
} from '../../../todos';
import type { TodosBrowser } from '../../../todos.browser';

const builtInById = new Map(
	BUILT_IN_CONTEXTS.map((context) => [context.id, context]),
);

export function createTodosState(todos: TodosBrowser) {
	const todosView = fromTable(todos.tables.todos);
	let selectedContextId = $state<ContextSlug | null>(null);

	const notDeletedTodos = $derived(
		[...todosView.all]
			.filter((todo) => todo.deletedAt === null)
			.sort(compareTodos),
	);

	const openTodos = $derived(
		notDeletedTodos.filter((todo) => todo.completedAt === null),
	);

	const completedTodos = $derived(
		notDeletedTodos.filter((todo) => todo.completedAt !== null),
	);

	const inSelectedContext = (todo: Todo) =>
		selectedContextId === null || todo.contexts.includes(selectedContextId);

	const selectedOpenTodos = $derived(openTodos.filter(inSelectedContext));
	const selectedCompletedTodos = $derived(
		completedTodos.filter(inSelectedContext),
	);

	return {
		/** Resolves after the initial SQLite table snapshot reaches the view. */
		whenReady: todosView.whenReady,
		get contexts() {
			return BUILT_IN_CONTEXTS;
		},
		get openTodos() {
			return openTodos;
		},
		get selectedOpenTodos() {
			return selectedOpenTodos;
		},
		get selectedCompletedTodos() {
			return selectedCompletedTodos;
		},
		get selectedContextId() {
			return selectedContextId;
		},
		selectContext(id: ContextSlug | null) {
			selectedContextId = id;
		},
		// A todo can carry a slug with no built-in (hand-edited file, mid-sync);
		// callers fall back to neutral rendering when this returns null.
		contextFor(slug: ContextSlug) {
			return builtInById.get(slug) ?? null;
		},
		contextLabel(slug: ContextSlug) {
			return builtInById.get(slug)?.name ?? slug;
		},
		contextCount(slug: ContextSlug) {
			return openTodos.filter((todo) => todo.contexts.includes(slug)).length;
		},
		createTodo(input: {
			title: string;
			body: string;
			dueDate: CalendarDateString | null;
			contexts: ContextSlug[];
		}) {
			return todos.actions.todos_create(input);
		},
		toggleTodo(id: TodoId, completed: boolean) {
			return todos.actions.todos_set_completed({ id, completed });
		},
		softDeleteTodo(id: TodoId) {
			return todos.actions.todos_delete({ id });
		},
		[Symbol.dispose]() {
			todosView[Symbol.dispose]();
		},
	};
}

function compareTodos(a: Todo, b: Todo): number {
	if (a.dueDate !== b.dueDate) {
		if (a.dueDate === null) return 1;
		if (b.dueDate === null) return -1;
		return a.dueDate.localeCompare(b.dueDate);
	}
	return a.createdAt.localeCompare(b.createdAt);
}
