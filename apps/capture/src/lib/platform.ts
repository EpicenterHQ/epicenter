/**
 * What Capture's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the online web app's by default,
 * the desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 */
import type { Capture } from '@epicenter/capture';
import type { ReactiveClient } from '@epicenter/svelte/client';
import type { Component, Snippet } from 'svelte';
import type { CaptureList } from './captures.svelte.js';

/** Which Capture this build is: the online web app, or the desktop app over its folder. */
export type Variant = 'online' | 'desktop';

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the pages over it: the person's
 * repository, signed in, on the web; the folder Capture keeps its files in
 * on the desktop, or its recovery screen. `store()` is that store, as the
 * pages read it. `Chrome` is the header's account of it: where the captures
 * are, and what can be done about it (sign out, or Sync with Epicenter).
 */
export type Platform = {
	Startup: Component<{ children: Snippet }>;
	store: () => ReactiveClient<Capture>;
	Chrome: Component<{ list: CaptureList }>;
};
