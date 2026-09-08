/// <reference lib="dom" />

import { createSessionAuth } from './create-session-auth.js';
import { createWebStoragePersistedAuthStorage } from './persisted-auth-storage.js';
import { createSessionHandoffClient } from './session-handoff-client.js';

export type CreateHostedBrowserRedirectAuthOptions = {
	appId: string;
	authorityId?: string;
	baseURL: string;
	callbackPath?: string;
};

/** Browser storage and redirect convention; applications own their Account. */
export function createHostedBrowserRedirectAuth({
	appId,
	authorityId,
	baseURL,
	callbackPath = '/auth/callback',
}: CreateHostedBrowserRedirectAuthOptions) {
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
		baseURL,
		fetch(input, init) {
			const target = new URL(input instanceof Request ? input.url : input);
			const headers = new Headers(init?.headers);
			// Better Auth's challenge/state cookies bind browser ceremonies. They
			// do not select the account: these exact routes require the captured
			// bearer and expected principal before any handler reads ambient cookies.
			const ceremony =
				target.origin === new URL(baseURL).origin &&
				target.origin === window.location.origin &&
				headers.has('authorization') &&
				headers.has('x-epicenter-principal') &&
				[
					'/auth/link-social',
					'/auth/passkey/generate-register-options',
					'/auth/passkey/verify-registration',
				].includes(target.pathname);
			return globalThis.fetch(input, {
				...init,
				credentials: ceremony ? 'include' : 'omit',
			});
		},
		persistedAuthStorage: createWebStoragePersistedAuthStorage({
			key: `${appId}.auth.persisted`,
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
