/**
 * What Capture's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the online web app's by default,
 * the desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 */
import type { Component, Snippet } from 'svelte';
import type { CaptureList } from './captures.svelte.js';

/** Which Capture this build is: the online web app, or the desktop app over its folder. */
export type Variant = 'online' | 'desktop';

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Root` chooses the store and sets it for every page under it (`setRepo`):
 * the person's repository, signed in, on the web; the folder Capture keeps
 * its files in, once chosen, on the desktop. `Chrome` is the header's
 * account of that store: where the captures are, and what can be done
 * about it (sign out, or Sync with Epicenter).
 */
export type Platform = {
	Root: Component<{ children: Snippet }>;
	Chrome: Component<{ list: CaptureList }>;
};
