/**
 * `#platform/root` in the web build: the person's `todos` repository,
 * signed in, online only (ADR-0700). The desktop window's is `root.tauri.ts`.
 */
import { getRepo } from '@epicenter/svelte/repo';
import OnlineChrome from './components/OnlineChrome.svelte';
import OnlineRoot from './components/OnlineRoot.svelte';
import type { Todos } from './contract.js';
import type { Platform } from './platform.js';

export const Startup: Platform['Startup'] = OnlineRoot;
export const store: Platform['store'] = () => getRepo<Todos>();
export const Chrome: Platform['Chrome'] = OnlineChrome;
