/**
 * `#platform/device` in Capture's desktop window: the folder its shell bound
 * to the window, the one Capture keeps its files in (asked for on first run,
 * `~/Epicenter/Capture` recommended), opened once for the page as Capture's
 * contract client (`@epicenter/folder/tauri`). The page names no path and
 * never uploads or signs in: Epicenter syncs the folder once the person asks
 * it to (decision 81).
 */

import { capture } from '@epicenter/capture';
import { openDevice } from '@epicenter/folder/tauri';

/** The window's folder, as Capture's client. */
export const device = openDevice(capture);
