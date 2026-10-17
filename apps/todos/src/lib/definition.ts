import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
} from '@epicenter/folder';
import manifest from '../../epicenter.app.json';

/**
 * Todos's own folder, named by its app id in `epicenter.app.json`. The
 * browser names its OPFS directory after it; the desktop shell registers its
 * directory under it.
 */
export const TODOS_FOLDER_ID = manifest.id;

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
