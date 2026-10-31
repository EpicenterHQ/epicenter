/**
 * `#platform/root` in the web build: the local variant, this browser's
 * storage for good (decision 77). The desktop window's is `root.tauri.ts`.
 */
import LocalChrome from '../components/LocalChrome.svelte';
import LocalStartup from '../components/LocalStartup.svelte';
import SignInCallback from '../components/SignInCallback.svelte';
import type { Platform } from './types.js';

export const Startup: Platform['Startup'] = LocalStartup;
export const Chrome: Platform['Chrome'] = LocalChrome;
export const Settings: Platform['Settings'] = null;
export const Callback: Platform['Callback'] = SignInCallback;
