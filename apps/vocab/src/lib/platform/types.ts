/**
 * The contracts of Vocab's two build seams (`#platform/*`, mapped in
 * `package.json` "imports"): the web build resolves the `.browser.ts`
 * leaves, the desktop build (`build:pages:desktop`) the `.tauri.ts` ones.
 * Each leaf annotates its export with these types, so the leaves stay the
 * same shape. Where the words and chats are is not a seam: each build's
 * root opens its own (the web's routes, the desktop's `src/desktop`).
 */
import type { ConnectionCatalog } from '@epicenter/ai/connections';
import type { AuthClient } from '@epicenter/auth';
import type { ReactiveAuthClient } from '@epicenter/auth/svelte';

/** Sign-in with Epicenter, and what it does in this build, in the learner's words. */
export type VocabAuth = ReactiveAuthClient<AuthClient> & {
	readonly purpose: {
		/** Why to sign in, shown signed out. */
		readonly signedOut: string;
		/** What the account does, shown signed in. */
		readonly signedIn: string;
	};
};

/** Opens this device's connected endpoints. */
export type OpenConnections = () => Promise<ConnectionCatalog>;
