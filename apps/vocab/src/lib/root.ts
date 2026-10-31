/**
 * `#platform/root` in the web build: the learner's `vocab` repository,
 * signed in, online only (ADR-0700). The desktop window's is `root.tauri.ts`.
 */
import { getRepo } from '@epicenter/svelte/repo';
import OnlineChrome from './components/OnlineChrome.svelte';
import OnlineRoot from './components/OnlineRoot.svelte';
import SignInCallback from './components/SignInCallback.svelte';
import type { Vocab } from './contract.js';
import type { Platform } from './platform.js';

export const Startup: Platform['Startup'] = OnlineRoot;
export const store: Platform['store'] = () => getRepo<Vocab>();
export const Chrome: Platform['Chrome'] = OnlineChrome;
export const Callback: Platform['Callback'] = SignInCallback;
