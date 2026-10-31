/**
 * What Honeycrisp's `#platform/*` seams (`package.json` "imports") promise
 * every build. The build picks the leaf: the online web app's by default,
 * the desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 */
import type { ReactiveClient } from '@epicenter/svelte/client';
import type { Component, Snippet } from 'svelte';
import type { Honeycrisp } from './contract.js';
import type { HoneycrispState } from './honeycrisp.svelte.js';

/** What the header tells `Chrome`: why the notes or folders did not list, if they did not. */
export type ChromeProps = { unreadable: HoneycrispState['notes']['error'] };

/** What the sign-in callback's page is given: where the app starts. */
export type CallbackProps = { home: string };

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the pages over it: the person's
 * repository, signed in, on the web; the folder Honeycrisp keeps its notes
 * in on the desktop, or its recovery screen. `store()` is that store, as the
 * pages read it. `Chrome` is the header's account of it: where the notes
 * are, and what can be done about it (sign out, or Sync with Epicenter).
 * `Callback` is the page that ends a sign-in, which only the web app makes.
 */
export type Platform = {
	Startup: Component<{ children: Snippet }>;
	store: () => ReactiveClient<Honeycrisp>;
	Chrome: Component<ChromeProps>;
	Callback: Component<CallbackProps>;
};
