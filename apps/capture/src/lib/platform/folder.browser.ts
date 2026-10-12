/**
 * The browser leaf: a folder in this browser's OPFS, with local Git
 * history and no remote. It opens through the browser entry only, which
 * refuses inside the desktop app instead of opening storage there.
 *
 * Another tab of this app writes the same folder. The page reads the
 * folder again when the person returns to it; every save is guarded, so a
 * change another tab made is a conflict, never overwritten.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import {
	CAPTURE_FOLDER_ID,
	type OnHostStopped,
	type OpenCaptureHost,
} from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const { data: folder, error } = await openFolder({
		id: CAPTURE_FOLDER_ID,
		definition: captureDefinition,
		// Complete saves request local history; pending requests coalesce.
		// History stays in this browser, with no remote to push to.
		browser: {
			author: { name: 'Capture', email: 'capture@localhost' },
			commitOnEdit: true,
		},
	});
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};

/** A tab has no host to stop. */
export const onHostStopped: OnHostStopped | undefined = undefined;
