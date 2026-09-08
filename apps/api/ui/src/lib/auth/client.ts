/** Hosted sign-in uses cookies; dashboard management captures one Account. */

import { passkeyClient } from '@better-auth/passkey/client';
import type { Account } from '@epicenter/auth';
import { createAuthClient } from 'better-auth/client';

export const authClient = createAuthClient({
	baseURL: typeof window === 'undefined' ? undefined : window.location.origin,
	basePath: '/auth',
	plugins: [passkeyClient()],
});

/** Every management request stays bound to the Account that opened this client. */
export function createAccountManagementClient(account: Account) {
	return createAuthClient({
		baseURL: account.baseURL,
		basePath: '/auth',
		// The mounted account page owns navigation after checking its lifetime.
		disableDefaultFetchPlugins: true,
		plugins: [passkeyClient()],
		fetchOptions: {
			credentials: 'omit',
			customFetchImpl: (input, init) => {
				const headers = new Headers(
					input instanceof Request ? input.headers : undefined,
				);
				new Headers(init?.headers).forEach((value, key) =>
					headers.set(key, value),
				);
				headers.delete('cookie');
				headers.set('x-epicenter-principal', account.principalId);
				return account.fetch(input, { ...init, headers, credentials: 'omit' });
			},
		},
	});
}

/** The browser exposes WebAuthn. The Better Auth server always has the plugin;
 *  this capability is the per-client gate the sign-in and account pages check. */
export function supportsPasskeys(): boolean {
	return typeof PublicKeyCredential !== 'undefined';
}

/** Better Auth's `{ data, error }` error arm. Its union has members that carry
 *  only some of these, so all are optional; the helpers below read what they
 *  need. */
export type AuthError = {
	status?: number;
	statusText?: string;
	message?: string;
	code?: string;
};

/**
 * A 401/403 on a login-method mutation means "sign in again": the session is
 * gone (401) or too old for the fresh-session gate (403 SESSION_NOT_FRESH, from
 * either this deployment's hook or Better Auth's own fresh middleware on
 * unlink). Both remedy the same way, so the callers branch on this, not on a
 * code string (Better Auth's unlink fresh-error carries no stable code).
 */
export function requiresReauth(error: AuthError | null): boolean {
	return error?.status === 401 || error?.status === 403;
}

/** The passkey client reports a dismissed/aborted browser prompt with these
 *  codes; callers reset quietly instead of showing an error. Takes the whole
 *  error because Better Auth's error union has arms without a `code`. */
export function isPasskeyCancellation(error: AuthError | null): boolean {
	const code = error?.code;
	return code === 'AUTH_CANCELLED' || code === 'ERROR_CEREMONY_ABORTED';
}
