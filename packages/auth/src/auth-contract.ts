import type { PrincipalId } from '@epicenter/principal';
import type { SocketTransport } from '@epicenter/sync/transport';
import type { Result } from 'wellcrafted/result';
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
export type Account = {
	readonly principalId: PrincipalId;
	readonly baseURL: string;
	fetch: AuthFetch;
	openWebSocket: SocketTransport['openWebSocket'];
	getProfile(): Promise<Result<Principal, AuthError>>;
};

export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in' | 'reauth-required'; account: Account };

export type ConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'unreachable'
	| 'rejected';

export type Connection = {
	baseURL: string;
	get status(): ConnectionStatus;
	onChange(fn: (status: ConnectionStatus) => void): () => void;
};

/** Auth selects accounts; applications hold the Account they opened. */
export type AuthClient = {
	state: AuthState;
	connection: Connection;
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

/** Only a redirect launcher can consume a sign-in callback. */
export type CallbackAuthClient = AuthClient & {
	completeSignIn(): Promise<Result<undefined, AuthError>>;
};

export function isCallbackAuthClient(
	client: AuthClient,
): client is CallbackAuthClient {
	return (
		typeof (client as Partial<CallbackAuthClient>).completeSignIn === 'function'
	);
}
