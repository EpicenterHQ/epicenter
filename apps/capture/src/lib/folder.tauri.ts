/**
 * Capture's desktop window's roots (decisions 88 and 89): its AppData root,
 * whose `settings.md` may name a data folder, and the requests that open the
 * data folder, `~/Epicenter/Capture` by default. `DesktopRoot` opens it as
 * the window starts. Only the desktop leaves import this.
 */
import { APPS } from '@epicenter/constants/apps';
import { desktopFolder } from '@epicenter/folder/tauri';

/** The window's roots, or null outside Capture's desktop shell. */
export const desktop = desktopFolder({
	// Where Capture's web app publishes its contract (`static/contract.json`).
	contract: `${APPS.CAPTURE.url}/contract.json`,
});
