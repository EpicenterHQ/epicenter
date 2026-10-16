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
 * schema, so `openHandedFolder` publishes `captureDefinition` to that folder
 * and reads any other through it as a lens, refusing one that does not
 * contain it by name.
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
import { openHandedFolder } from '@epicenter/folder/tauri';
import { CAPTURE_FOLDER_ID, type OpenCaptureHost } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const { data, error } = await openHandedFolder({
		ownId: CAPTURE_FOLDER_ID,
		definition: captureDefinition,
		appTitle: 'Capture',
	});
	if (error) throw new Error(error.message, { cause: error });
	const { folder } = data;
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};
