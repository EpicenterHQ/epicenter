/**
 * The browser leaf: the Local demo, a folder in this browser's OPFS with a
 * loopback Git remote reached through the same-origin Vite proxy. Nothing
 * native is imported here.
 *
 * Opened only after the person chooses the Local demo (`#platform/start`).
 * An earlier version of the demo recorded only the remote's URL; that
 * explicit choice confirms its branch, `main`, the one it always used. A
 * folder kept with another remote is refused, not changed.
 */
import { openFolder } from '@epicenter/folder/browser';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
		browser: {
			author: { name: 'Todos', email: 'todos@localhost' },
			remote: { url: `${location.origin}/git/todos.git`, branch: 'main' },
			confirmLegacyRemoteBranch: true,
		},
	});
