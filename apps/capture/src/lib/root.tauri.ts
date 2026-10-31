/**
 * `#platform/root` in Capture's desktop window: the folder Capture keeps its
 * files in (decisions 88 and 89), or the recovery screen when it cannot be opened. The
 * window never signs in: Epicenter syncs the folder once the person asks.
 */
import DesktopChrome from './components/DesktopChrome.svelte';
import DesktopRoot from './components/DesktopRoot.svelte';
import type { Platform } from './platform.js';

export const Root: Platform['Root'] = DesktopRoot;
export const Chrome: Platform['Chrome'] = DesktopChrome;
