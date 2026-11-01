/**
 * `#platform/root` in Vocab's desktop window: its two roots (decision 94),
 * opened before any page renders, or the recovery screen when one cannot
 * be. Signing in only adds hosted tutor models and dictation; Epicenter
 * syncs the folder once the learner asks.
 */
import DesktopCallback from './components/DesktopCallback.svelte';
import DesktopChrome from './components/DesktopChrome.svelte';
import Startup from './components/Startup.svelte';
import type { Platform } from './platform.js';

export { Startup };
export const Chrome: Platform['Chrome'] = DesktopChrome;
export const Callback: Platform['Callback'] = DesktopCallback;
