/// <reference lib="dom" />

import { tryAsync } from 'wellcrafted/result';
import {
	type AuthClient,
	type AuthStartup,
	isCallbackAuthClient,
} from './auth-contract.js';
import { AuthError } from './auth-errors.js';
import { createBrowserRedirectAuth } from './browser-redirect-auth.js';
import { createInstanceAuth } from './create-session-auth.js';
import {
	type CreateHostedBrowserRedirectAuthOptions,
	createHostedBrowserRedirectAuth,
} from './hosted-browser-redirect-auth.js';
import { normalizeInstanceServer } from './instance-server.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';

/** Select one server at document startup. A server change saves the next boot
 * selection and replaces the document; its issuer then verifies the person.
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
	let invalidSelection = false;
	let namedIssuer = false;
	try {
		if (selectedOrigin !== null) {
			// Earlier static-token selections remain attached to the historical identity.
			if (selectedOrigin.startsWith('{')) {
				const selected = JSON.parse(selectedOrigin);
				if (selected.method !== 'issuer' || typeof selected.origin !== 'string')
					throw new Error('Invalid saved issuer.');
				server = normalizeInstanceServer(selected.origin);
				if (server.baseURL === new URL(options.baseURL).origin)
					throw new Error('Use Epicenter Cloud to connect to this server.');
				namedIssuer = true;
			} else server = normalizeInstanceServer(selectedOrigin);
		}
	} catch {
		server = null;
		invalidSelection = true;
	}
	const instanceStorage = (baseURL: string) =>
		createWebStoragePersistedAuthStorage({
			key: `${options.appId}.auth.instance:${baseURL}`,
			storage,
		});
	// Invalid selection has no credential owner. In particular, neither reading
	// state nor recovering may restore or revoke a surviving Cloud credential.
	const auth: AuthClient | null = invalidSelection
		? null
		: server
			? namedIssuer
				? createBrowserRedirectAuth({ ...options, ...server })
				: createInstanceAuth({
						baseURL: server.baseURL,
						persistedAuthStorage: instanceStorage(server.baseURL),
					})
			: createHostedBrowserRedirectAuth(options);
	let selection: AbortController | undefined;
	let disposed = false;
	function cancelSelection() {
		selection?.abort();
		selection = undefined;
	}
	function reopen(path = '/') {
		disposed = true;
		auth?.[Symbol.dispose]();
		window.location.replace(path);
	}
	const startSignIn = auth?.startSignIn;
	const client = auth
		? {
				baseURL: auth.baseURL,
				onStateChange: auth.onStateChange,
				getProfile: auth.getProfile,
				accountManagementUrl: auth.accountManagementUrl,
				get state() {
					return auth.state;
				},
				...(startSignIn
					? {
							startSignIn(options?: { reauthenticate?: boolean }) {
								cancelSelection();
								return startSignIn(options);
							},
						}
					: {}),
				...(isCallbackAuthClient(auth)
					? {
							completeSignIn: auth.completeSignIn,
							cancelSignIn: auth.cancelSignIn,
						}
					: {}),
				signOut() {
					cancelSelection();
					return auth.signOut();
				},
				[Symbol.dispose]() {
					disposed = true;
					cancelSelection();
					auth[Symbol.dispose]();
				},
			}
		: null;
	return {
		auth: client,
		selectedServer: server?.baseURL ?? null,
		connectInstance(input: { url?: string }) {
			cancelSelection();
			const attempt = new AbortController();
			selection = attempt;
			return tryAsync({
				try: async () => {
					if (disposed) throw new Error('Connection screen closed.');
					const next = normalizeInstanceServer(
						input.url ?? server?.baseURL ?? '',
					);
					if (next.baseURL === new URL(options.baseURL).origin)
						throw new Error('Use Epicenter Cloud to connect to this server.');
					if (namedIssuer && next.baseURL === server?.baseURL && startSignIn) {
						const result = await startSignIn();
						if (result.error) throw result.error;
						return undefined;
					}
					const signedOut = await auth?.signOut();
					if (signedOut?.error) throw signedOut.error;
					attempt.signal.throwIfAborted();
					storage.setItem(
						selectionKey,
						JSON.stringify({ method: 'issuer', origin: next.baseURL }),
					);
					reopen('/?connect');
					return undefined;
				},
				catch: (cause) => AuthError.StartSignInFailed({ cause }),
			}).finally(() => {
				if (selection === attempt) selection = undefined;
			});
		},
		useCloud() {
			cancelSelection();
			if (!server && startSignIn) return startSignIn();
			const attempt = new AbortController();
			selection = attempt;
			return tryAsync({
				try: async () => {
					if (disposed) throw new Error('Connection screen closed.');
					const result = await auth?.signOut();
					if (result?.error) throw result.error;
					attempt.signal.throwIfAborted();
					storage.removeItem(selectionKey);
					reopen('/?connect');
					return undefined;
				},
				catch: (cause) => AuthError.StartSignInFailed({ cause }),
			}).finally(() => {
				if (selection === attempt) selection = undefined;
			});
		},
		[Symbol.dispose]() {
			disposed = true;
			cancelSelection();
			auth?.[Symbol.dispose]();
		},
	} satisfies AuthStartup;
}
export type BrowserAuth = ReturnType<typeof createBrowserAuth>;
