/**
 * What makes sense on one computer and stays on it, outside the folder:
 * it names hardware or holds a secret, and the folder may be
 * in a Git history or a file syncer.
 *
 * - A secret (a provider's API key) is a Keychain item on the desktop,
 *   which the shell keeps (`src-tauri/src/secrets.rs`), and in
 *   `localStorage` in a browser, which has no credential store a page can
 *   put a key in.
 * - Everything else (where the folder is, the microphone) is in
 *   `localStorage`.
 *
 * The page sends what needs a key itself: on the desktop through Tauri's
 * HTTP plugin, which no endpoint's CORS refuses, and in a browser with its
 * own `fetch`.
 */

import { invoke, isTauri } from '@tauri-apps/api/core';
import { extractErrorMessage } from 'wellcrafted/error';

const PREFIX = 'whispering.';

/** One value kept in `localStorage`; a storage that refuses reads as nothing kept. */
export function localValue(name: string) {
	const key = `${PREFIX}${name}`;
	return {
		get(): string | null {
			try {
				return localStorage.getItem(key);
			} catch {
				return null;
			}
		},
		/** Keep `value`, or forget it with null; throws when the storage refuses. */
		set(value: string | null) {
			if (value === null) localStorage.removeItem(key);
			else localStorage.setItem(key, value);
		},
	};
}

/** Where the person moved the folder on the desktop; null is the default, `data/` in the app's local data directory. */
export const folderPath = localValue('folder');

/** This computer's secrets, by name. */
type Secrets = {
	/** Where they are kept, as Settings tells the person. */
	readonly where: 'keychain' | 'browser';
	/** The secret kept as `name`, or null. Rejects when it cannot be read. */
	get(name: string): Promise<string | null>;
	/** Keep `value` as `name`; null forgets it. Rejects when it cannot be kept. */
	set(name: string, value: string | null): Promise<void>;
};

/** The shell's failure, a string, as an error. */
const failure = (cause: unknown) =>
	cause instanceof Error ? cause : new Error(extractErrorMessage(cause));

const keychain: Secrets = {
	where: 'keychain',
	get: (name) =>
		invoke<string | null>('secret_get', { name }).catch((cause) => {
			throw failure(cause);
		}),
	set: (name, value) =>
		invoke<void>('secret_set', { name, value }).catch((cause) => {
			throw failure(cause);
		}),
};

const browserSecrets: Secrets = {
	where: 'browser',
	get: async (name) => localValue(`secret.${name}`).get(),
	set: async (name, value) => localValue(`secret.${name}`).set(value),
};

export const secrets: Secrets = isTauri() ? keychain : browserSecrets;

/** A Fetch API function. */
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Tauri's HTTP plugin, loaded with the first request so a browser never
 * loads it. It follows no redirect: a request goes only where it was
 * prepared to go.
 */
const desktopFetch: Fetch = async (input, init) => {
	const http = await import('@tauri-apps/plugin-http');
	return http.fetch(input, { ...init, maxRedirections: 0 });
};

/** What a request to a model endpoint is sent with. */
export const requestFetch: Fetch = isTauri()
	? desktopFetch
	: globalThis.fetch.bind(globalThis);

/**
 * The folder the person left when "Change…" opened another Whispering
 * folder; Settings shows it so its recordings can be exported. Null when
 * there is none.
 */
export const previousFolderPath = localValue('previousFolder');
