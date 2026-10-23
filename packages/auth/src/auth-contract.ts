import type { AccountIdentity } from '@epicenter/principal';
import type { Result } from 'wellcrafted/result';
import type { createAccountManagementUrl } from './account-management.js';
import type { AuthError } from './auth-errors.js';
import type { Principal } from './auth-types.js';

export type AuthFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** One uninterrupted attachment to one person on one server.
 *
 * Capture this value when opening a data session. Refresh and reauthentication
 * preserve it. Sign-out or account replacement permanently retires its network
 * access, including in-flight requests. A later sign-in creates a
 * new Account even for the same person. Retirement does not erase local data.
 */
export type Account = AccountIdentity & {
	readonly baseURL: string;
	fetch: AuthFetch;
	getProfile(): Promise<Result<Principal, AuthError>>;
};

export type AuthState =
	| { status: 'signed-out'; account?: undefined }
	| { status: 'signed-in' | 'reauth-required'; account: Account };

/** Auth selects accounts; applications hold the Account they opened. */
export type AuthClient = {
	getState(): AuthState;
	baseURL: string;
	accountManagementUrl?: typeof createAccountManagementUrl;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(options?: {
		reauthenticate?: boolean;
	}): Promise<Result<undefined, AuthError>>;
	/** Retire locally and clear persistence. Hosted clients await a revocation
	 * attempt for up to five seconds; success does not confirm remote revocation.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	getProfile(): Promise<Result<Principal, AuthError>>;
	[Symbol.dispose](): void;
};

/** A client whose sign-in returns to a callback page it must complete. */
export type CallbackAuthClient = AuthClient & {
	/**
	 * Finish the sign-in this page's URL answers. Success carries the path the
	 * attempt started from, which the callback page replaces itself with; it is
	 * undefined when that path cannot be used.
	 */
	completeSignIn(): Promise<
		Result<{ returnTo: string | undefined }, AuthError>
	>;
};

/** Narrow the callback capability on either a plain client or a UI facade. */
export function isCallbackAuthClient<
	TClient extends Pick<AuthClient, 'startSignIn'>,
>(
	client: TClient,
): client is TClient & Pick<CallbackAuthClient, 'completeSignIn'> {
	return (
		typeof (client as { completeSignIn?: unknown }).completeSignIn ===
		'function'
	);
}
