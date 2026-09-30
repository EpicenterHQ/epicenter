import { type Folder, openBrowserFolder } from '@epicenter/app/files';
import { todosDefinition } from './definition.js';

export type TodosFolder = Folder<typeof todosDefinition>;

/**
 * The remote is the loopback Git backend, reached same-origin through the
 * Vite proxy. Without the backend, pushes and fetches fail and say so; saves
 * and local commits still work.
 */
export function todosRemote() {
	return { url: `${location.origin}/git/todos.git`, branch: 'main' } as const;
}

/** Called from a mounted component; importing this module opens nothing. */
export function openTodosFolder(): Promise<TodosFolder> {
	return openBrowserFolder({
		id: todosDefinition.id,
		definition: todosDefinition,
		git: {
			author: { name: 'Todos', email: 'todos@localhost' },
			remote: todosRemote(),
		},
	});
}
