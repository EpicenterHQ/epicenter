/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * todos are a real directory the shell registered and granted this window.
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Todos's own folder, `TODOS_FOLDER_ID`, or another
 * folder whose declaration contains Todos's shape (ADR-0538). A window handed
 * no folder opens Todos's own.
 *
 * Todos owns its own folder's schema, so `openHandedFolder` publishes
 * `todosDefinition` to that folder and reads any other through it as a lens,
 * refusing one that does not contain it by name. Only Todos's own folder
 * offers Connect (`OpenedTodosFolder`).
 *
 * The shell chooses, locks, and grants the directory; the page opens it with
 * the folder's file storage and the system `git`, and reads the author and
 * remote from Git's configuration. Pushes and fetches sign in through the
 * `epicenter` command, which holds the desktop grant and the person's Git
 * credential helper. Imports acquire nothing, and a folder that cannot be
 * opened is a refusal; browser storage is not opened.
 */
import { openHandedFolder } from '@epicenter/folder/tauri';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = () =>
	openHandedFolder({
		ownId: TODOS_FOLDER_ID,
		definition: todosDefinition,
		appTitle: 'Todos',
	});
