/**
 * `@epicenter/folder/next`: open the runtime's own folder. In a browser tab
 * it is this origin's local folder; in the desktop app, the directory the
 * shell bound to this window. Decided when called, loading only that engine.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { Opened, OpenOptions, Tables } from './folder.js';

export * from './index.js';

export async function openFolder<const T extends Tables>(
	options: OpenOptions<T>,
): Opened<T> {
	if (isTauri()) return (await import('./tauri.js')).openFolder(options);
	return (await import('./browser.js')).openFolder(options);
}
