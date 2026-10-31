/**
 * `#platform/root` in the web build: the person's `honeycrisp` repository,
 * signed in, online only (ADR-0700). The desktop window's is `root.tauri.ts`.
 */
import OnlineChrome from './components/OnlineChrome.svelte';
import OnlineRoot from './components/OnlineRoot.svelte';
import SignInCallback from './components/SignInCallback.svelte';
import type { Platform } from './platform.js';

export const Root: Platform['Root'] = OnlineRoot;
export const Chrome: Platform['Chrome'] = OnlineChrome;
export const Callback: Platform['Callback'] = SignInCallback;
