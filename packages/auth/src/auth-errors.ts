import type { SyncRefusal } from '@epicenter/sync/transport';
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
	/**
	 * A sign-in that was already launched could not be finished from the
	 * callback the transport received.
	 *
	 * Separate from `StartSignInFailed` because the repairs are different and a
	 * surface has to be able to tell them apart: starting again is what repairs
	 * a failed launch, and it is exactly the wrong answer to a callback whose
	 * authorization code was already spent.
	 */
	CompleteSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to complete sign-in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign out: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ProfileUnavailable: ({ cause }: { cause: unknown }) => ({
		message: `Failed to read profile: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type AuthError = InferErrors<typeof AuthError>;

/** A socket dial refused before it could receive a usable credential. */
export const OpenWebSocketDenied = defineErrors({
	OpenWebSocketDenied: ({ code }: { code: SyncRefusal }) => ({
		message: `No usable bearer for the WebSocket upgrade (${code}).`,
		code,
	}),
}).OpenWebSocketDenied;

/** HTTP authorization failed before a request could be dispatched. */
export const AccountUnavailable = defineErrors({
	AccountUnavailable: ({ code }: { code: SyncRefusal }) => ({
		message: `Account network access is unavailable (${code}).`,
		code,
	}),
}).AccountUnavailable;
