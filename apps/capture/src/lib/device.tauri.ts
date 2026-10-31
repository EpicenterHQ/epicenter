/**
 * `#platform/device` in Capture's desktop window: the folder Capture keeps
 * its files in (decision 82), opened by the path the shell gave this window
 * (`appFolders()`), as Capture's contract client. Null until the person
 * chooses a folder, when the page asks where (`ChooseFolder.svelte`). The
 * page never uploads or signs in: Epicenter syncs the folder once the person
 * asks it to.
 */

import { capture } from '@epicenter/capture';
import { appFolders, openDevice } from '@epicenter/folder/tauri';

const folder = appFolders()?.folder ?? null;

/** The window's folder, as Capture's client, or null before the first choice. */
export const device =
	folder === null ? null : openDevice(capture, { path: folder });
