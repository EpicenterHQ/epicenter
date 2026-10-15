/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory the shell grants this window, and the page
 * runs the folder engine over it (ADR-0531): the shell makes each read and
 * change and runs the folder's `git`. It opens through the desktop entry
 * only, which refuses outside the shell.
 *
 * The page names the folder by its ID and nothing else; the shell chose the
 * directory, the fallback author, and the windows that may use it. The
 * collection finishes its intended saves before closing closes the folder:
 * nothing else finishes them once the page is gone.
 *
 * A refused grant or a missing plugin fails the open with its reason. There is no
 * browser folder to fall back to in this build.
 *
 * Quitting Epicenter asks this window nothing (ADR-0542).
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/tauri';
import { CAPTURE_FOLDER_ID, type OpenCaptureHost } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const { data: folder, error } = await openFolder({
		id: CAPTURE_FOLDER_ID,
		definition: captureDefinition,
	});
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};
