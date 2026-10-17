/**
 * The seam between the Capture UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf attaches
 * to a real directory the desktop shell owns; the browser leaf opens a
 * logical folder in OPFS. Neither leaf imports the other's storage.
 */

import type { captureDefinition } from '@epicenter/capture';
import type { Folder, FolderDefinition } from '@epicenter/folder';
import manifest from '../../../epicenter.app.json';

/**
 * Capture's own folder, named by its app id in `epicenter.app.json`. The
 * browser names its scoped OPFS directory after it and opens no other; the
 * desktop shell registers its directory under it and hands it to a window
 * opened without a folder.
 */
export const CAPTURE_FOLDER_ID = manifest.id;

/**
 * The folder a leaf opens: its captures table, its files (a capture's exact
 * text), its Git history, and its channel of outside changes. Its own
 * `definition` is `captureDefinition` for Capture's own folder, and the
 * folder's declaration for any other folder the desktop hands Capture, read
 * through Capture's definition.
 */
export type CaptureFolder = Folder<typeof captureDefinition, FolderDefinition>;

/**
 * Opens the build's folder. A folder that cannot be opened throws; a leaf
 * never opens another kind of storage instead. The page closes the folder
 * once the collection has finished its intended saves; calls that reach
 * storage after that are refused. On the desktop, closing lets go of this
 * page's use, and the folder stays open for the shell and its other windows.
 */
export type OpenCaptureFolder = () => Promise<CaptureFolder>;
