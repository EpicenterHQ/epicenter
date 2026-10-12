/**
 * The desktop leaf of the window seam: this page's own window, through
 * Tauri. Importing registers nothing; the page listens when it mounts.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { OnCloseRequested } from './types.js';

export const onCloseRequested: OnCloseRequested | undefined = (handler) =>
	getCurrentWindow().onCloseRequested(handler);
