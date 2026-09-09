import type { AccountIdentity } from '@epicenter/principal';
import type { SocketTransport } from '@epicenter/sync/transport';
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
 * access, including in-flight requests and sockets. A later sign-in creates a
 * new Account even for the same person. Retirement does not erase local data.
 */
export type Account = AccountIdentity & {
	readonly baseURL: string;
	fetch: AuthFetch;
	openWebSocket: SocketTransport['openWebSocket'];
	getProfile(): Promise<Result<Principal, AuthError>>;
};

export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in' | 'reauth-required'; account: Account };

/** Auth selects accounts; applications hold the Account they opened. */
export type AuthClient = {
	state: AuthState;
	baseURL: string;
	accountManagementUrl?: typeof createAccountManagementUrl;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn?(options?: {
		reauthenticate?: boolean;
	}): Promise<Result<undefined, AuthError>>;
	/** Retire locally and clear persistence. Hosted clients await a revocation
	 * attempt for up to five seconds; success does not confirm remote revocation.
	 */
	signOut(): Promise<Result<undefined, AuthError>>;
	getProfile(): Promise<Result<Principal, AuthError>>;
	[Symbol.dispose](): void;
};

/** Session clients expose sign-in independently of the issuer. */
export type SessionAuthClient = AuthClient & {
	startSignIn: NonNullable<AuthClient['startSignIn']>;
};

/** Only a redirect launcher can consume a sign-in callback. */
export type CallbackAuthClient = SessionAuthClient & {
	completeSignIn(): Promise<Result<undefined, AuthError>>;
};

/** One document or host startup selection and its available sign-in actions. */
export type AuthStartup = {
	auth: AuthClient | null;
	selectedServer: string | null;
	/** Server selection and sign-in belong to host settings. */
	signInLocation?: 'host-settings';
	connectInstance?: (input: {
		url?: string;
	}) => Promise<Result<undefined, AuthError>>;
	useCloud?: () => Promise<Result<undefined, AuthError>>;
	[Symbol.dispose](): void;
};

export function isCallbackAuthClient(
	client: AuthClient,
): client is CallbackAuthClient {
	return (
		typeof (client as Partial<CallbackAuthClient>).completeSignIn === 'function'
	);
}
