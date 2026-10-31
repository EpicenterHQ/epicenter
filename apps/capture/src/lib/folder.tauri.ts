/**
 * Capture's desktop window's folder and settings (decisions 81 and 82), from
 * the roots the shell gave it, and the folder as Capture's client: null
 * until the person chooses where Capture keeps its files. Only the desktop
 * leaves import this.
 */
import { capture } from '@epicenter/capture';
import { APPS } from '@epicenter/constants/apps';
import { desktopFolder, openDevice } from '@epicenter/folder/tauri';

/** The window's folder and settings, or null outside Capture's desktop shell. */
export const folder = desktopFolder({
	// Where Capture's web app publishes its contract (`static/contract.json`).
	contract: `${APPS.CAPTURE.url}/contract.json`,
});

/** The folder as Capture's client, or null before the first choice. */
export const device =
	folder === null || folder.path === null
		? null
		: openDevice(capture, { path: folder.path });
