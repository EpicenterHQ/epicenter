/**
 * `#platform/components` in Whispering's desktop window: the header's
 * account of the data folder and the global shortcut's presses; the
 * settings only the desktop has (the data folder, the models on this
 * computer, and the shortcut); and the callback page it never comes to,
 * since it signs in through the system browser. Epicenter syncs the folder
 * once the person asks.
 */
import DesktopCallback from '../components/DesktopCallback.svelte';
import DesktopChrome from '../components/DesktopChrome.svelte';
import DesktopSettings from '../components/DesktopSettings.svelte';
import type { Platform } from './types.js';

export const Chrome: Platform['Chrome'] = DesktopChrome;
export const Settings: Platform['Settings'] = DesktopSettings;
export const Callback: Platform['Callback'] = DesktopCallback;
