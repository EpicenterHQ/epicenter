/**
 * `#platform/root` in Honeycrisp's desktop window: the folder Honeycrisp
 * keeps its notes in (decisions 88 and 89), or the recovery screen when it cannot be opened.
 * The window never signs in: Epicenter syncs the folder once the person asks.
 */
import DesktopCallback from './components/DesktopCallback.svelte';
import DesktopChrome from './components/DesktopChrome.svelte';
import DesktopRoot from './components/DesktopRoot.svelte';
import type { Platform } from './platform.js';

export const Root: Platform['Root'] = DesktopRoot;
export const Chrome: Platform['Chrome'] = DesktopChrome;
export const Callback: Platform['Callback'] = DesktopCallback;
