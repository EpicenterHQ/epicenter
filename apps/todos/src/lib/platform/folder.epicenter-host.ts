/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * todos are a real directory the shell registered and granted this window.
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Todos's own folder, `TODOS_FOLDER_ID`, or another
 * folder whose declaration contains Todos's shape (ADR-0538). A window handed
 * no folder opens Todos's own.
 *
 * Todos owns its own folder's schema, so it opens that folder with
 * `openFolder`, which publishes `todosDefinition`. Any other folder opens
 * with `openDataFolder` and `todosDefinition` as the lens: its declaration is
 * never written, and one that does not contain the lens is refused, named.
 * Only Todos's own folder offers Connect (`OpenedTodosFolder`).
 *
 * The shell chooses, locks, and grants the directory; the page opens it with
 * the folder's file storage and the system `git`, and reads the author and
 * remote from Git's configuration. A push or fetch to Epicenter's server, or
 * to a remote with a pasted token, signs in with what `gitAccess` gives;
 * any other uses the person's own Git credentials. Imports acquire nothing,
 * and a folder that cannot be opened is a refusal; browser storage is not
 * opened.
 */
import { openDataFolder, openFolder } from '@epicenter/folder/tauri';
import { Err, Ok } from 'wellcrafted/result';
import { todosDefinition } from '../definition.js';
import { gitAccess } from '../remote.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** The scope the shell handed this window as `?folder=`, if any. */
function handedFolder(): string | undefined {
	const handed = new URLSearchParams(globalThis.location?.search).get('folder');
	return handed || undefined;
}

/**
 * The folder's name as a person knows it, its directory's: the shell scopes
 * a listed folder `data:<directory>`, and an app's own folder by its
 * directory, the app's id (`apps/epicenter/src-tauri/src/data_folders.rs`).
 */
function folderName(id: string): string {
	return id.startsWith('data:') ? id.slice('data:'.length) : id;
}

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = async () => {
	const id = handedFolder() ?? TODOS_FOLDER_ID;
	if (id === TODOS_FOLDER_ID) {
		const { data: folder, error } = await openFolder({
			id,
			definition: todosDefinition,
			credentials: gitAccess.credentials,
		});
		if (error !== null) return Err(error);
		return Ok({ folder, own: true });
	}
	const { data: folder, error } = await openDataFolder({
		id,
		lens: todosDefinition,
		credentials: gitAccess.credentials,
	});
	if (error === null) return Ok({ folder, own: false });
	if (error.name !== 'ShapeMismatch') return Err(error);
	return Err({
		...error,
		message: `Todos cannot open the folder '${folderName(id)}': ${error.problems.map((problem) => problem.message).join('; ')}.`,
	});
};
