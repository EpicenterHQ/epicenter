/**
 * The browser leaf: a folder in this browser's OPFS, with local Git
 * history and no remote. It opens through the browser entry only, which
 * refuses inside the desktop app instead of opening storage there.
 *
 * Another tab of this app writes the same folder. The folder reports the
 * paths each tab writes to the others on its change channel, and every save
 * merges with what another tab changed since the edit started.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { CAPTURE_FOLDER_ID, type OpenCaptureFolder } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureFolder: OpenCaptureFolder = async () => {
	const { data: folder, error } = await openFolder({
		id: CAPTURE_FOLDER_ID,
		definition: captureDefinition,
		// Saves never commit; a version is recorded only when a person saves one (ADR-0529).
		// History stays in this browser, with no remote to push to.
		browser: {
			author: { name: 'Capture', email: 'capture@localhost' },
		},
	});
	if (error) throw new Error(error.message, { cause: error });
	return folder;
};

/** A tab has no host to quit; its leave warning covers a reload or a close. */
