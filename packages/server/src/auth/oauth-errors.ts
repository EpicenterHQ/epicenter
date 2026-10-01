import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the bearer resource boundary.
 *
 * Emitted by the bearer-token resolver and surfaced to clients via
 * `createOAuthUnauthorizedResourceResponse`:
 *   - HTTP: `c.json(error, 401)` with `WWW-Authenticate: Bearer error="invalid_token"`.
 *   - WebSocket: close code 4401 with the error JSON in the close reason.
 *
 * Owned by the server auth layer that emits it. The server calls the factory at
 * runtime (`OAuthError.InvalidToken()`); consumers that only narrow (a client
 * SDK, or `apps/api`'s dev bearer resolver) import the value or type from
 * `@epicenter/server`, where it is re-exported. HTTP responses serialize the
 * error payload `{ name, message, status }`; receivers branch on `body.name`.
 *
 * The variant carries its own HTTP `status`, so call sites just forward
 * the baked-in code to `c.json`. No external status mapper required.
 *
 * `ServerError` (503) is distinct from `InvalidToken`: it means the resource
 * server could not verify the token because the session database was
 * unavailable, not because the token is bad. Flattening that case into a
 * 401 would make clients discard a perfectly good token (and pause
 * network auth) over a transient server fault, so it gets its own retryable
 * status instead.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { OAuthError } from '../auth/oauth-errors.js';
 * if (!accessToken) return OAuthError.InvalidToken();
 *
 * // Client: type-only narrowing
 * import type { OAuthError } from '@epicenter/server';
 * function handle(error: OAuthError) {
 *   switch (error.name) {
 *     case 'InvalidToken':  // missing, malformed, unverifiable, or user-not-found
 *     case 'ServerError':   // token unverifiable due to a server-side fault
 *   }
 * }
 * ```
 */
export const OAuthError = defineErrors({
	InvalidToken: () => ({
		message: 'Bearer token is missing, malformed, or unverifiable.',
		status: 401 as const,
	}),
	ServerError: () => ({
		message: 'Bearer token verification is temporarily unavailable.',
		status: 503 as const,
	}),
});

/**
 * Discriminated union of all bearer resource-boundary error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type OAuthError = InferErrors<typeof OAuthError>;
