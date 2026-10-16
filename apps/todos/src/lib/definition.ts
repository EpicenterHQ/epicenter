import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
} from '@epicenter/folder';

/**
 * Each todo is `todos/<stem>.md`: `title` and `done` in frontmatter, notes in
 * the Markdown body. The stem is the file's identity; the title is a field.
 */
export const todosDefinition = defineFolder({
	title: 'Todos',
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

export type TodoFields = CreateRowOf<typeof todosDefinition.tables.todos>;
