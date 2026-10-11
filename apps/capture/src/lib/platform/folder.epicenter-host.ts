/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory owned by the shell's Rust folder plugin. It
 * opens through the desktop entry only, which refuses outside the shell.
 *
 * The page names the folder by its ID and nothing else; the shell chose the
 * directory, the author, the history policy, and which windows may use it.
 * The collection finishes its intended saves before closing detaches this
 * page. The folder stays open for the shell and its other windows.
 *
 * A refused or missing plugin fails the open with its reason. There is no
 * browser folder to fall back to in this build.
 *
 * Before Epicenter quits or restarts, it sends this window one flush signal
 * and waits about a second (`@epicenter/epicenter/page-close`). Its events
 * are heard only when sent to this window, and the host knows the caller by
 * its window.
 */
import { captureDefinition } from '@epicenter/capture';
import { onHostClose, onHostStopped } from '@epicenter/epicenter/page-close';
import { openFolder } from '@epicenter/folder/tauri';
import {
	CAPTURE_FOLDER_ID,
	type HostSignals,
	type OpenCaptureHost,
} from './types.js';

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

/** Registered by the mounted page once the captures exist. */
export const hostSignals: HostSignals = {
	close: onHostClose,
	stopped: onHostStopped,
};
