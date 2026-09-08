/// <reference lib="dom" />

import { tryAsync } from 'wellcrafted/result';
import type { AuthClient } from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import type { PersistedAuth } from './auth-types.js';
import { createInstanceAuth } from './create-session-auth.js';
import {
	type CreateHostedBrowserRedirectAuthOptions,
	createHostedBrowserRedirectAuth,
} from './hosted-browser-redirect-auth.js';
import { normalizeInstanceServer } from './instance-server.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';

/** Select one server at document startup. A server change verifies a new
 * candidate, saves the next boot selection, then replaces the document.
 * Call connection actions only after the application owner has finished closing
 * its current App. No running Account changes its server or its data address.
 */
export function createBrowserAuth(
	options: CreateHostedBrowserRedirectAuthOptions,
) {
	const selectionKey = `${options.appId}.auth.server`;
	const storage = window.localStorage;
	const selectedOrigin = storage.getItem(selectionKey);
	let server: ReturnType<typeof normalizeInstanceServer> | null = null;
	try {
		if (selectedOrigin) server = normalizeInstanceServer(selectedOrigin);
	} catch {
		/* Invalid saved selection returns to the hosted connection screen. */
	}
	const instanceStorage = (baseURL: string) =>
		createWebStoragePersistedAuthStorage({
			key: `${options.appId}.auth.instance:${baseURL}`,
			storage,
		});
	const auth = server
		? createInstanceAuth({
				...server,
				persistedAuthStorage: instanceStorage(server.baseURL),
				async requestToken() {
					throw new Error('Use the server connection form.');
				},
			})
		: createHostedBrowserRedirectAuth(options);
	let generation = 0;
	let candidate: AuthClient | undefined;
	let disposed = false;
	function cancelCandidate() {
		generation++;
		candidate?.[Symbol.dispose]();
		candidate = undefined;
	}
	function reopen() {
		disposed = true;
		auth[Symbol.dispose]();
		window.location.replace('/');
	}
	return {
		...auth,
		get state() {
			return auth.state;
		},
		selectedServer: server?.baseURL ?? null,
		startSignIn(options?: { reauthenticate?: boolean }) {
			cancelCandidate();
			return auth.startSignIn(options);
		},
		connectInstance(input: { url: string; token: string }) {
			cancelCandidate();
			const attempt = generation;
			return tryAsync({
				try: async () => {
					if (disposed) throw new Error('Connection screen closed.');
					const next = normalizeInstanceServer(input.url);
					let verified: PersistedAuth | null = null;
					const pending = createInstanceAuth({
						...next,
						persistedAuthStorage: {
							initial: null,
							set(value) {
								verified = value;
							},
						},
						requestToken: async () => input.token,
					});
					candidate = pending;
					const result = await pending.startSignIn();
					if (result.error) throw result.error;
					if (attempt !== generation || disposed)
						throw new Error('Connection cancelled.');
					const signedOut = await auth.signOut();
					if (signedOut.error) throw signedOut.error;
					if (attempt !== generation || disposed)
						throw new Error('Connection cancelled.');
					if (!verified)
						throw new Error('The server did not verify the credential.');
					const credentialKey = `${options.appId}.auth.instance:${next.baseURL}`;
					const previous = storage.getItem(credentialKey);
					// Web Storage is synchronous: cancellation cannot interleave this commit.
					storage.setItem(credentialKey, JSON.stringify(verified));
					try {
						storage.setItem(selectionKey, next.baseURL);
					} catch (error) {
						if (previous === null) storage.removeItem(credentialKey);
						else storage.setItem(credentialKey, previous);
						throw error;
					}
					reopen();
					return undefined;
				},
				catch: (cause) => AuthError.StartSignInFailed({ cause }),
			}).finally(() => {
				if (attempt === generation) {
					candidate?.[Symbol.dispose]();
					candidate = undefined;
				}
			});
		},
		useHostedServer() {
			cancelCandidate();
			const attempt = generation;
			return tryAsync({
				try: async () => {
					if (disposed) throw new Error('Connection screen closed.');
					const result = await auth.signOut();
					if (result.error) throw result.error;
					if (attempt !== generation || disposed)
						throw new Error('Connection cancelled.');
					storage.removeItem(selectionKey);
					reopen();
					return undefined;
				},
				catch: (cause) => AuthError.StartSignInFailed({ cause }),
			});
		},
		signOut() {
			cancelCandidate();
			return auth.signOut();
		},
		[Symbol.dispose]() {
			disposed = true;
			cancelCandidate();
			auth[Symbol.dispose]();
		},
	};
}
export type BrowserAuth = ReturnType<typeof createBrowserAuth>;
export function isBrowserAuth(auth: AuthClient): auth is BrowserAuth {
	return 'connectInstance' in auth && 'useHostedServer' in auth;
}
