import {
	type CreateRowOf,
	defineFolder,
	defineTable,
	field,
} from '@epicenter/folder';
import { Type } from 'typebox';
import manifest from '../../epicenter.app.json';

/**
 * The tables Todos reads from this browser's local folder,
 * `openFolder({ tables: todosTables })`: each todo is `todos/<id>.md`, with
 * `title` and `done` in frontmatter and notes in the body. The schema only
 * interprets: other fields survive a save, and a file that does not fit is
 * listed with its source and issues.
 */
export const todosTables = {
	todos: Type.Object({ title: Type.String(), done: Type.Boolean() }),
};

/**
 * Todos's own folder, named by its app id in `epicenter.app.json`. The
 * desktop shell registers its directory under it. An earlier browser build
 * kept its todos in the OPFS directory of this name, which Todos keeps
 * opening while it exists (`storage-choice.ts`).
 */
export const TODOS_FOLDER_ID = manifest.id;

/**
 * The declaration the desktop build and the legacy browser folder open
 * through. Each todo is `todos/<stem>.md`: `title` and `done` in frontmatter,
 * notes in the Markdown body. The stem is the file's identity; the title is a
 * field.
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
