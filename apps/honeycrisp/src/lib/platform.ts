/**
 * What Honeycrisp's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the online web app's by default,
 * the desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 */
import type { Component, Snippet } from 'svelte';
import type { HoneycrispState } from './honeycrisp.svelte.js';

/** What the header tells `Chrome`: why the notes or folders did not list, if they did not. */
export type ChromeProps = { unreadable: HoneycrispState['notes']['error'] };

/** What the sign-in callback's page is given: where the app starts. */
export type CallbackProps = { home: string };

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Root` chooses the store and sets it for every page under it (`setRepo`):
 * the person's repository, signed in, on the web; the folder Honeycrisp
 * keeps its notes in, once chosen, on the desktop. `Chrome` is the header's
 * account of that store: where the notes are, and what can be done about it
 * (sign out, or Sync with Epicenter). `Callback` is the page that ends a
 * sign-in, which only the web app makes.
 */
export type Platform = {
	Root: Component<{ children: Snippet }>;
	Chrome: Component<ChromeProps>;
	Callback: Component<CallbackProps>;
};
