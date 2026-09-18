/// <reference lib="dom" />

import type { AuthFetch } from './auth-contract.js';
import { createSessionAuth } from './create-session-auth.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';
import { createSessionHandoffClient } from './session-handoff-client.js';

export type CreateBrowserRedirectAuthOptions = {
	authorityId: string;
	supportsShared?: boolean;
	fetch?: AuthFetch;
	appId: string;
	baseURL: string;
	callbackPath?: string;
};

/** Browser storage and redirect convention; applications own their Account. */
export function createBrowserRedirectAuth({
	authorityId,
	supportsShared,
	fetch,
	appId,
	baseURL,
	callbackPath = '/auth/callback',
}: CreateBrowserRedirectAuthOptions) {
	if (
		!callbackPath.startsWith('/') ||
		callbackPath.startsWith('//') ||
		/[?#\\\\]/.test(callbackPath)
	)
		throw new TypeError('The callback must be an absolute local path.');
	const callback = new URL(callbackPath, window.location.origin);
	if (callback.origin !== window.location.origin)
		throw new TypeError('The callback must stay on the application origin.');
	const handoff = createSessionHandoffClient({
		baseURL,
		callback: callback.href,
		storage: window.sessionStorage,
	});
	return createSessionAuth({
		authorityId,
		supportsShared,
		baseURL,
		fetch,
		persistedAuthStorage: createWebStoragePersistedAuthStorage({
			key: `${appId}.auth.persisted:${new URL(baseURL).origin}`,
			storage: window.localStorage,
		}),
		launcher: {
			async startSignIn({ signal, reauthenticate }) {
				signal.throwIfAborted();
				const url = await handoff.begin();
				signal.throwIfAborted();
				if (reauthenticate) url.searchParams.set('reauth', '1');
				window.location.href = url.href;
				return { status: 'launched' };
			},
			async completeSignIn({ signal }) {
				signal.throwIfAborted();
				return handoff.complete(window.location.href);
			},
			cancel() {
				handoff.cancel();
			},
		},
	});
}
