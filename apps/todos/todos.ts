import { InstantString } from '@epicenter/field';
import {
	type AsyncWorkspace,
	defineTable,
	field,
	nullable,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import Type from 'typebox';
import type { Brand } from 'wellcrafted/brand';

export const TODOS_APP_ID = 'epicenter-todos';

export type TodoId = string & Brand<'TodoId'>;

/**
 * Built-in contexts are the complete fixed set in version 1. They are code
 * constants rather than durable rows, so every workspace sees the same set.
 */
export const BUILT_IN_CONTEXTS = [
	{ id: 'phone', name: 'Phone', color: 'sky' },
	{ id: 'computer', name: 'Computer', color: 'violet' },
	{ id: 'desk', name: 'Desk', color: 'emerald' },
] as const;

export type ContextSlug = (typeof BUILT_IN_CONTEXTS)[number]['id'];

const BUILT_IN_CONTEXT_IDS = new Set<ContextSlug>(
	BUILT_IN_CONTEXTS.map((context) => context.id),
);

function isContextSlug(value: unknown): value is ContextSlug {
	return (
		typeof value === 'string' && BUILT_IN_CONTEXT_IDS.has(value as ContextSlug)
	);
}

/**
 * Stored rows tolerate an unknown string from external table editing. The
 * application create path accepts only the built-in version 1 slugs.
 */
const contextSlugSchema = Type.Unsafe<ContextSlug>(Type.String());

export const todosTable = defineTable({
	fields: {
		id: field.string<TodoId>(),
		title: field.string({ minLength: 1 }),
		body: field.string(),
		dueDate: nullable(field.date()),
		contexts: field.json(Type.Array(contextSlugSchema)),
		completedAt: nullable(field.instant()),
		deletedAt: nullable(field.instant()),
		createdAt: field.instant(),
	},
});

export type Todo = RowFor<typeof todosTable>;
export type TodosWorkspace = AsyncWorkspace<{ todos: typeof todosTable }>;

function normalizeContextSlugs(slugs: readonly string[]): ContextSlug[] {
	const unique = new Set<ContextSlug>();
	for (const slug of slugs) {
		if (!isContextSlug(slug)) throw new Error(`Unknown context: ${slug}`);
		unique.add(slug);
	}
	return [...unique];
}

/** Compose executable Todos behavior over one already-open async workspace. */
export function createTodosActions({ tables }: Pick<TodosWorkspace, 'tables'>) {
	return {
		/** List every visible todo from the current workspace authority. */
		async todos_list(): Promise<Todo[]> {
			return (await tables.todos.list()).filter(
				(todo) => todo.deletedAt === null,
			);
		},

		/** Validate user input and create a fresh framework-owned todo identity. */
		async todos_create(input: {
			title: string;
			body?: string;
			dueDate?: Todo['dueDate'];
			contexts?: ContextSlug[];
		}): Promise<TodoId> {
			const title = input.title.trim();
			if (title === '') throw new Error('Todo title is required');
			const row = await tables.todos.create({
				title,
				body: input.body ?? '',
				dueDate: input.dueDate ?? null,
				contexts: normalizeContextSlugs(input.contexts ?? []),
				completedAt: null,
				deletedAt: null,
				createdAt: InstantString.now(),
			});
			return row.id;
		},

		/** Mark an existing todo complete or incomplete without recreating it. */
		async todos_set_completed(input: {
			id: TodoId;
			completed: boolean;
		}): Promise<void> {
			await tables.todos.patch(input.id, {
				completedAt: input.completed ? InstantString.now() : null,
			});
		},

		/** Hide a todo through its application-level soft-delete field. */
		async todos_delete(input: { id: TodoId }): Promise<void> {
			await tables.todos.patch(input.id, {
				deletedAt: InstantString.now(),
			});
		},
	};
}

export type TodosActions = ReturnType<typeof createTodosActions>;
