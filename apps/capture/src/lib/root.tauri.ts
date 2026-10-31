/**
 * `#platform/root` in Capture's desktop window: the folder Capture keeps its
 * files in (decisions 81 and 82), or the question of where, first. The
 * window never signs in: Epicenter syncs the folder once the person asks.
 */
import DesktopChrome from './components/DesktopChrome.svelte';
import DesktopRoot from './components/DesktopRoot.svelte';
import type { Platform } from './platform.js';

export const Root: Platform['Root'] = DesktopRoot;
export const Chrome: Platform['Chrome'] = DesktopChrome;
