/**
 * `#platform/root` in Whispering's desktop window: its two roots (decision
 * 94), opened before any page renders, or the recovery screen when one
 * cannot be; the header's account of the data folder and the global
 * shortcut; and the settings only the desktop has (the data folder and the
 * models on this computer). Epicenter syncs the folder once the person asks.
 */
import DesktopCallback from '../components/DesktopCallback.svelte';
import DesktopChrome from '../components/DesktopChrome.svelte';
import DesktopSettings from '../components/DesktopSettings.svelte';
import DesktopStartup from '../components/DesktopStartup.svelte';
import type { Platform } from './types.js';

export const Startup: Platform['Startup'] = DesktopStartup;
export const Chrome: Platform['Chrome'] = DesktopChrome;
export const Settings: Platform['Settings'] = DesktopSettings;
export const Callback: Platform['Callback'] = DesktopCallback;
