import { defineStore, defineTable, field } from '@epicenter/app';

/**
 * Each todo is `todos/<stem>.md`: `title` and `done` in frontmatter, notes in
 * the Markdown body. The stem is the file's identity; the title is a field.
 */
export const todosDefinition = defineStore({
	id: 'so.epicenter.todos',
	title: 'Todos',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

export type TodoFields = { title: string; done: boolean };
