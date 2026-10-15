/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory the shell grants this window, and the page
 * runs the folder engine over it (ADR-0531): the shell makes each read and
 * change and runs the folder's `git`. It opens through the desktop entry
 * only, which refuses outside the shell.
 *
 * The shell opens the window with the folder it hands it as `?folder=<scope>`
 * (`open_installed_app`): Capture's own folder, `CAPTURE_FOLDER_ID`, or
 * another folder whose declaration contains Capture's shape (ADR-0538). A
 * window handed no folder opens Capture's own. Capture owns its own folder's
 * schema, so it opens that folder with `openFolder`, which publishes
 * `captureDefinition`. Any other folder opens with `openDataFolder` and
 * `captureDefinition` as the lens: its declaration is never written, and one
 * that does not contain the lens is refused, named.
 *
 * The page names the folder by its scope and nothing else; the shell chose
 * the directory, the fallback author, and the windows that may use it. The
 * collection finishes its intended saves before closing closes the folder:
 * nothing else finishes them once the page is gone.
 *
 * A refused grant or a missing plugin fails the open with its reason. There is no
 * browser folder to fall back to in this build.
 *
 * Quitting Epicenter asks this window nothing (ADR-0542).
 */
import { captureDefinition } from '@epicenter/capture';
import { openDataFolder, openFolder } from '@epicenter/folder/tauri';
import { CAPTURE_FOLDER_ID, type OpenCaptureHost } from './types.js';

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
export const openCaptureHost: OpenCaptureHost = async () => {
	const id = handedFolder() ?? CAPTURE_FOLDER_ID;
	const { data: folder, error } =
		id === CAPTURE_FOLDER_ID
			? await openFolder({ id, definition: captureDefinition })
			: await openDataFolder({ id, lens: captureDefinition });
	if (error?.name === 'ShapeMismatch')
		throw new Error(
			`Capture cannot open the folder '${folderName(id)}': ${error.problems.map((problem) => problem.message).join('; ')}.`,
			{ cause: error },
		);
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};
