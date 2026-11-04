/** `#platform/variant` in the web build, the local variant; the desktop window's is `variant.tauri.ts`. */
import type { Variant } from './types.js';

export const variant: Variant = 'local';

/** Where a connection's key is kept, and where its requests leave from, in the person's words. */
export const connectionsNote = () =>
	`A connection's key is kept in this browser's storage for this site, where code running on the site can read it. Its requests leave this browser tab, so its endpoint must allow requests from ${location.origin} (CORS). Epicenter's models go through Epicenter's API and have no such limit.`;
