/**
 * The Epicenter host leaf: Honeycrisp is an installed app (ADR-0552), so the
 * notes are a real directory the Epicenter shell grants this window, and the
 * page runs the folder engine over it (ADR-0531).
 *
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Honeycrisp's own folder, `HONEYCRISP_FOLDER_ID`, or
 * another folder whose declaration contains Honeycrisp's shape (ADR-0538). A
 * window handed no folder opens Honeycrisp's own.
 *
 * `openFolder` publishes `honeycrispDefinition` only to Honeycrisp's own
 * folder, the one named after it, and this leaf sets up what that folder's
 * layout is missing (`first-open.ts`). Any other folder is read through
 * `honeycrispDefinition`: its declaration is never written, nothing is set up
 * in it, and one that does not contain the definition is refused, named.
 *
 * The page names the folder by its scope and nothing else; the shell chose
 * the directory, the fallback author, and the windows that may use it. The
 * author and any `origin` come from Git's configuration.
 *
 * A folder that cannot be opened is an error on screen. There is no browser
 * folder to fall back to in this build. Quitting Epicenter asks this window
 * nothing (ADR-0542).
 */
import { openFolder } from '@epicenter/folder/tauri';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import { HONEYCRISP_FOLDER_ID, type OpenNotesFolder } from './types.js';

/** Called from the mounted page; importing this module opens nothing. */
export const openNotesFolder: OpenNotesFolder = async () => {
	const { data: folder, error } = await openFolder({
		app: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
	});
	if (error) throw new Error(error.message, { cause: error });
	if (!folder.own) return folder;
	try {
		// The shell holds the directory's lock now. An existing folder is
		// left as it is.
		await setUpFolder(folder.files, Object.keys(honeycrispDefinition.tables));
	} catch (cause) {
		await folder.close();
		throw cause;
	}
	return folder;
};
