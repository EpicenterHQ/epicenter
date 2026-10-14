/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * todos are a real directory the shell registered under `TODOS_FOLDER_ID`.
 * The shell chooses, locks, and grants the directory; the page opens it with
 * the folder's file storage and the system `git`, and reads the author and
 * remote from Git's configuration. Imports acquire nothing, and a folder that cannot be opened is
 * a refusal; browser storage is not opened.
 */
import { openFolder } from '@epicenter/folder/tauri';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
	});
