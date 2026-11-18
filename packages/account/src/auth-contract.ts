import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { Principal } from './auth-types.js';
import type { AccountIdentity } from './principal.js';

export type AuthFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * The dashboard's attachment to the person named by its session cookie.
 * A sign-out or account replacement retires the attachment and aborts
 * in-flight requests. Signing in again creates a new Account.
 */
export type Account = AccountIdentity & {
	readonly baseURL: string;
	/** Aborts when the dashboard retires this Account. */
	readonly signal: AbortSignal;
	fetch: AuthFetch;
	getProfile(): Promise<Result<Principal, AuthError>>;
};

export type AuthState =
	| { status: 'signed-out'; account?: undefined }
	| { status: 'signed-in'; account: Account };

/** Cookie session operations the dashboard reads and invokes. */
export type AuthClient = {
	state(): AuthState;
	/** Refresh the session state from the server. */
	refresh(): Promise<void>;
	baseURL: string;
	/** Call `listener` whenever `state()` may answer differently; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	startSignIn(options?: {
		reauthenticate?: boolean;
	}): Promise<Result<undefined, AuthError>>;
	/** End the browser session and retire its Account. */
	signOut(): Promise<Result<undefined, AuthError>>;
	getProfile(): Promise<Result<Principal, AuthError>>;
	[Symbol.dispose](): void;
};
