import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the loopback `/api` surface of `local-mail app`.
 *
 * Every non-2xx response from the Hono app ({@link api.ts}, its only emitter)
 * comes from one of these variants, so the wire shape is `wellcrafted`'s
 * envelope `{ data: null, error: { name, message, status } }` and each variant
 * bakes in its own HTTP `status`. Emit as `c.json(err, err.error.status)`; the
 * `c-json-errors` biome gate is satisfied because a factory result is not an
 * inline object literal.
 *
 * The one consumer is the same-origin SPA, which surfaces `error.message` in a
 * toast; it does not branch on `error.name`. The variants exist to keep the
 * error surface centralized and typed, not because a remote client reads them.
 *
 * @example
 * ```ts
 * import { ApiError } from './api-errors.ts';
 * const err = ApiError.MessageNotFound();
 * return c.json(err, err.error.status); // 404
 * ```
 */
export const ApiError = defineErrors({
	/** Missing or stale bearer on a gated `/api` route. A stale bearer means the
	 * host rotated it (a restart), so reloading the page re-reads the current
	 * injected bearer. */
	Unauthorized: () => ({
		message: 'Unauthorized. Reload the page to re-authenticate.',
		status: 401 as const,
	}),
	/** The `:account` path segment names no account the host loaded at launch.
	 * The app enumerates connected accounts once at start, so an account
	 * connected after launch is unknown until the next restart. */
	AccountNotFound: () => ({
		message: 'Unknown account. Reload after connecting it.',
		status: 404 as const,
	}),
	/** No mirror row for the requested message id. */
	MessageNotFound: () => ({
		message: 'Message not found.',
		status: 404 as const,
	}),
	/** A triage act was refused before anything was recorded: read-only mode, no
	 * ids, too many ids, an empty label set, or a label name the mirror does not
	 * know. Nothing here reports a Gmail failure; the act path never calls Gmail. */
	AssertFailed: ({ message }: { message: string }) => ({
		message,
		status: 400 as const,
	}),
	/** No route matched under `/api`. */
	NotFound: () => ({
		message: 'Not found.',
		status: 404 as const,
	}),
});

/** Discriminated union of all `/api` error payloads, keyed by `name`. */
export type ApiError = InferErrors<typeof ApiError>;
