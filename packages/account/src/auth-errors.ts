import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

/** Failures the dashboard cookie session can return. */
export const AuthError = defineErrors({
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
