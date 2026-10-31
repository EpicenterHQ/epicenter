/**
 * `#platform/root` in Todos' desktop window: its two roots (decision 94),
 * opened before any page renders, or the recovery screen when one cannot be.
 * The window never signs in: Epicenter syncs the folder once the person asks.
 */
import DesktopChrome from './components/DesktopChrome.svelte';
import Startup from './components/Startup.svelte';
import { getDevice } from './folder.tauri.js';
import type { Platform } from './platform.js';

export { Startup };
export const store: Platform['store'] = getDevice;
export const Chrome: Platform['Chrome'] = DesktopChrome;
