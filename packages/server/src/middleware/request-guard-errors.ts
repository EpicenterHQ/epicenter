import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the guards' own refusals, emitted before a
 * handler runs. An access token's refusal is the RFC 6750 answer
 * `resource-access.ts` builds; these are the rest:
 *
 *   - `TokenCheckUnavailable` (503): `requireAccessToken` could not read the
 *     database, so the client keeps its token and retries.
 *
 * and the session-cookie guard's (`requireSessionCookie`):
 *
 *   - `ForbiddenOrigin` (403): the request came from another origin, or
 *     changes state without naming its origin.
 *   - `SessionRequired` (401): no live session cookie.
 *   - `SessionUnavailable` (503): the session could not be read, so the
 *     client should retry rather than sign in again.
 *   - `PrincipalMismatch` (403): the cookie is another account's than the
 *     one the page was opened for.
 *
 * Owned by the server middleware that emits them. The server calls the
 * factories at runtime; client SDKs only narrow branches on `body.error.name`
 * off the wire.
 *
 * The serialized envelope is `wellcrafted`'s `{ data: null, error: {
 * name, message, ...fields } }`. Each variant carries its own HTTP `status`,
 * so call sites just forward the baked-in code to `c.json`.
 *
 * @example
 * ```ts
 * import { RequestGuardError } from '../middleware/request-guard-errors.js';
 * const err = RequestGuardError.ForbiddenOrigin();
 * return c.json(err, err.error.status); // status is baked into the variant
 * ```
 */
export const RequestGuardError = defineErrors({
	ForbiddenOrigin: () => ({
		message:
			"The request did not come from the authorization server's own origin.",
		status: 403 as const,
	}),
	SessionRequired: () => ({
		message: 'Sign in to the authorization server first.',
		status: 401 as const,
	}),
	TokenCheckUnavailable: () => ({
		message: 'The access token could not be checked. Try again.',
		status: 503 as const,
	}),
	SessionUnavailable: () => ({
		message: 'The session could not be checked. Try again.',
		status: 503 as const,
	}),
	PrincipalMismatch: () => ({
		message: 'The signed-in account is not the one this page was opened for.',
		status: 403 as const,
	}),
});

/**
 * Discriminated union of all request-guard error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type RequestGuardError = InferErrors<typeof RequestGuardError>;
