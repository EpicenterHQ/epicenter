import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for request-boundary refusals.
 *
 * Emitted before the resource handler runs domain logic. Two flavors,
 * grouped because they share the property "request was malformed at the
 * boundary, not by the domain":
 *
 *   - `ForbiddenOrigin` (403): middleware-level CSRF refusal: origin
 *     missing or not in the trusted-origin allowlist.
 *   - `MissingNodeId` (400): route-level input refusal: WebSocket
 *     upgrade is missing the required `nodeId` query parameter.
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
		message: 'Origin header is missing or not in the trusted-origin allowlist.',
		status: 403 as const,
	}),
	PrincipalMismatch: () => ({
		message: 'The signed-in account is not the one this page was opened for.',
		status: 403 as const,
	}),
	MissingNodeId: () => ({
		message:
			'WebSocket upgrade is missing the required nodeId query parameter.',
		status: 400 as const,
	}),
});

/**
 * Discriminated union of all request-guard error payloads.
 *
 * The `name` field discriminates variants in exhaustive `switch`
 * statements with `default: error satisfies never`.
 */
export type RequestGuardError = InferErrors<typeof RequestGuardError>;
