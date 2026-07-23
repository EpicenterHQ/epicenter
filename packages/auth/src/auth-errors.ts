import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/**
 * Public auth-core failures returned by `AuthClient` methods.
 *
 * Launcher and storage-specific errors stay as causes. Callers should branch on
 * the auth-core operation that failed, then inspect `cause` only for diagnostics.
 */
export const AuthError = defineErrors({
	StartSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to start sign-in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RefreshGrantFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to refresh OAuth grant: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ProfileUnavailable: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read profile: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type AuthError = InferErrors<typeof AuthError>;

/**
 * Thrown (not returned) by `SyncAuthClient.openWebSocket` when no usable
 * bearer can be attached: a protected socket is never opened credential-less.
 * The error object conforms to the `OpenWebSocketDenial` contract in
 * `@epicenter/sync/auth-subprotocol`, which the sync supervisor classifies:
 * `'permanent'` parks sync until the auth state changes, `'transient'` backs
 * off and retries.
 */
export const OpenWebSocketDenied = defineErrors({
	OpenWebSocketDenied: ({
		permanence,
		code,
	}: {
		permanence: 'permanent' | 'transient';
		code: string;
	}) => ({
		message: `No usable bearer for the WebSocket upgrade (${code}).`,
		permanence,
		code,
	}),
}).OpenWebSocketDenied;
