/**
 * What Vocab's `#platform/*` seams (`package.json` "imports") promise every
 * build. The build picks the leaf: the online web app's by default, the
 * desktop window's under the `tauri` condition (`bun run build:native`).
 * Each leaf annotates against these types, so both stay one shape.
 *
 * - `#platform/root` (`Platform`): which store the pages run over, and the
 *   few components that speak of it.
 * - `#platform/auth` (`VocabAuth`): sign-in with Epicenter, and what it does
 *   in this build.
 * - `#platform/connections` (`OpenConnections`): the endpoints a learner
 *   connected on this device, and where their keys are.
 */
import type { ConnectionCatalog } from '@epicenter/ai/connections';
import type { AuthClient } from '@epicenter/auth';
import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
import type { ReactiveClient } from '@epicenter/svelte/client';
import type { Component, Snippet } from 'svelte';
import type { Vocab } from './contract.js';

/** What the header tells `Chrome`: why the words or chats did not list, if they did not. */
export type ChromeProps = { unreadable: { message: string } | null };

/** What the sign-in callback's page is given: where the app starts. */
export type CallbackProps = { home: string };

/**
 * `#platform/root`: the one thing a variant decides (decision 78).
 * `Startup` opens the store and renders the pages over it: the learner's
 * repository, signed in, on the web; the folder Vocab keeps its words and
 * chats in on the desktop, or its recovery screen. `store()` is that store,
 * as the pages read it. `Chrome` is the header's account of it: where the
 * words are, and what can be done about it (sign in again, or Sync with
 * Epicenter and Choose data folder…), beside the account. `Callback` is the
 * page that ends a sign-in, which only the web app makes.
 */
export type Platform = {
	Startup: Component<{ children: Snippet }>;
	store: () => ReactiveClient<Vocab>;
	Chrome: Component<ChromeProps>;
	Callback: Component<CallbackProps>;
};

/** `#platform/auth`: sign-in with Epicenter, and what it does in this build, in the learner's words. */
export type VocabAuth = ReactiveAuthClient<AuthClient> & {
	readonly purpose: {
		/** Why to sign in, shown signed out. */
		readonly signedOut: string;
		/** What the account does, shown signed in. */
		readonly signedIn: string;
	};
};

/**
 * `#platform/connections`: open this device's connected endpoints. The web
 * app keeps them in this browser's storage for the site, keys included; the
 * desktop window keeps the list in its AppData root's `connections.md` and
 * each key in the keychain.
 */
export type OpenConnections = () => Promise<ConnectionCatalog>;
