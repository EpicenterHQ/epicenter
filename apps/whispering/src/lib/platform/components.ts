/**
 * `#platform/components` in the web build, the local variant: the header's
 * account of this browser's storage (decision 77), no settings of its own,
 * and the page that ends a sign-in. The desktop window's is
 * `components.tauri.ts`.
 */
import LocalChrome from '../components/LocalChrome.svelte';
import SignInCallback from '../components/SignInCallback.svelte';
import type { Platform } from './types.js';

export const Chrome: Platform['Chrome'] = LocalChrome;
export const Settings: Platform['Settings'] = null;
export const Callback: Platform['Callback'] = SignInCallback;
