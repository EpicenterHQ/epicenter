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
 * When the Bun host that served the page stops, the shell keeps this window
 * and tells it (`@epicenter/epicenter/host-stopped`). The event is heard only
 * when sent to this window.
 */
import { captureDefinition } from '@epicenter/capture';
import { onHostStopped as hearHostStopped } from '@epicenter/epicenter/host-stopped';
import { openFolder } from '@epicenter/folder/tauri';
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
	});
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};

/** Registered by the mounted page once the captures exist. */
export const onHostStopped: OnHostStopped | undefined = hearHostStopped;
