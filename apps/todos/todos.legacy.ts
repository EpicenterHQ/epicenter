/**
 * Legacy synchronous Todos workspace used only by the unmigrated Epicenter
 * desktop host. New app code uses the versioned SQLite package root.
 */

import { field, InstantString } from '@epicenter/field';
import {
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	defineWorkspace,
	generateId,
	nullable,
} from '@epicenter/workspace';
import { Type } from 'typebox';
import {
	BUILT_IN_CONTEXTS,
	type ContextSlug,
	TODOS_APP_ID,
	type TodoId,
} from './todos.js';

const builtInContextIds = new Set<ContextSlug>(
	BUILT_IN_CONTEXTS.map((context) => context.id),
);
const contextSlugSchema = Type.Unsafe<ContextSlug>(Type.String());

function normalizeContextSlugs(slugs: readonly string[]): ContextSlug[] {
	const unique = new Set<ContextSlug>();
	for (const slug of slugs) {
		if (!builtInContextIds.has(slug as ContextSlug)) {
			throw new Error(`Unknown context: ${slug}`);
		}
		unique.add(slug as ContextSlug);
	}
	return [...unique];
}

const todosTable = defineTable({
	id: field.string<TodoId>(),
	title: field.string({ minLength: 1 }),
	body: field.string(),
	dueDate: nullable(field.date()),
	contexts: field.json(Type.Array(contextSlugSchema)),
	completedAt: nullable(field.instant()),
	deletedAt: nullable(field.instant()),
	createdAt: field.instant(),
});

export const todosWorkspace = defineWorkspace({
	id: TODOS_APP_ID,
	name: 'Todos',
	tables: { todos: todosTable },
	kv: {},
	actions({ tables }) {
		return defineActions({
			todos_list: defineQuery({
				description: 'List todos',
				handler: () =>
					tables.todos.scan().rows.filter((todo) => todo.deletedAt === null),
			}),
			todos_create: defineMutation({
				description: 'Create a todo',
				input: Type.Object({
					title: Type.String(),
					body: Type.Optional(Type.String()),
					dueDate: Type.Optional(Type.Union([field.date(), Type.Null()])),
					contexts: Type.Optional(Type.Array(contextSlugSchema)),
				}),
				handler: (input) => {
					const title = input.title.trim();
					if (title === '') throw new Error('Todo title is required');
					const id = generateId<TodoId>();
					tables.todos.set({
						id,
						title,
						body: input.body ?? '',
						dueDate: input.dueDate ?? null,
						contexts: normalizeContextSlugs(input.contexts ?? []),
						completedAt: null,
						deletedAt: null,
						createdAt: InstantString.now(),
					});
					return id;
				},
			}),
			todos_set_completed: defineMutation({
				description: 'Mark a todo complete or incomplete',
				input: Type.Object({
					id: Type.Unsafe<TodoId>(Type.String()),
					completed: Type.Boolean(),
				}),
				handler: ({ id, completed }) => {
					tables.todos.update(id, {
						completedAt: completed ? InstantString.now() : null,
					});
				},
			}),
			todos_delete: defineMutation({
				description: 'Soft-delete a todo',
				input: Type.Object({ id: Type.Unsafe<TodoId>(Type.String()) }),
				handler: ({ id }) => {
					tables.todos.update(id, { deletedAt: InstantString.now() });
				},
			}),
		});
	},
});
