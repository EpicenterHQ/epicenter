/**
 * The browser leaf: a folder in this browser's OPFS. Opening writes nothing;
 * the first todo creates it. Its remote is its Git configuration, which
 * Connect sets, and each push and fetch signs in with what `gitAccess` gives
 * for that exact URL. Nothing native is imported here.
 */
import { openFolder } from '@epicenter/folder/browser';
import { todosDefinition } from '../definition.js';
import { gitAccess } from '../remote.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Who records the versions this browser makes. */
const AUTHOR = { name: 'Todos', email: 'todos@epicenter.so' };

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
		credentials: gitAccess.credentials,
		browser: { author: AUTHOR },
	});
