import { type Folder, openBrowserFolder } from '@epicenter/app/files';
import { todosDefinition } from './definition.js';

export type TodosFolder = Folder<typeof todosDefinition>;

/** Called from a mounted component; importing this module opens nothing. */
export function openTodosFolder(): Promise<TodosFolder> {
	return openBrowserFolder({
		id: todosDefinition.id,
		definition: todosDefinition,
		git: {
			author: { name: 'Todos', email: 'todos@localhost' },
			// The loopback backend is reached through the same-origin Vite proxy.
			remote: { url: `${location.origin}/git/todos.git`, branch: 'main' },
		},
	});
}
