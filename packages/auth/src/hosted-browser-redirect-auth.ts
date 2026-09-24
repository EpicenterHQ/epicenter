/// <reference lib="dom" />

import { createAccountManagementUrl } from './account-management.js';
import { epicenterCloud } from './auth-server.js';
import { createBrowserRedirectAuth } from './browser-redirect-auth.js';

export type CreateHostedBrowserRedirectAuthOptions = {
	appId: string;
	baseURL: string;
	callbackPath?: string;
};

/** Cloud issuer policy over the shared browser session handoff. */
export function createHostedBrowserRedirectAuth(
	options: CreateHostedBrowserRedirectAuthOptions,
) {
	const { baseURL } = options;
	return Object.assign(
		createBrowserRedirectAuth({
			...options,
			server: epicenterCloud(baseURL),
			accountManagement: true,
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
		}),
		{ accountManagementUrl: createAccountManagementUrl },
	);
}
