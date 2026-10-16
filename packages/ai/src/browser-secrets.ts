/**
 * A browser page's `SecretStore` (ADR-0581), apart from the folder code in
 * `browser-connections.ts`, so the shared connection editor can name it
 * without bringing a browser folder into a desktop build.
 */

import type { SecretStore } from './send.js';

/** The `localStorage` key a connection's `{ endpoint, key }` is kept under. */
export function secretStorageKey(connection: string) {
	return `so.epicenter.secret.${connection}`;
}

/**
 * The page's `SecretStore`: one `localStorage` entry per connection id.
 * Any script on the origin can read it, which the connection form says
 * before a key is saved.
 */
export function browserSecrets(
	storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): SecretStore {
	// Read at each call, so a page that never sends with a key never touches it.
	const store = () => storage ?? globalThis.localStorage;
	return {
		async get(name) {
			return store().getItem(secretStorageKey(name));
		},
		async set(name, value) {
			store().setItem(secretStorageKey(name), value);
		},
		async delete(name) {
			const key = secretStorageKey(name);
			const present = store().getItem(key) !== null;
			store().removeItem(key);
			return present;
		},
	};
}
