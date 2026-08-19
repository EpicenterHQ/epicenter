import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the loopback `/api` surface of `local-books app`.
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
 * const err = ApiError.RowNotFound();
 * return c.json(err, err.error.status); // 404
 * ```
 */
export const ApiError = defineErrors({
	/** Missing or unknown bearer on a gated `/api` route. */
	Unauthorized: () => ({
		message: 'Unauthorized. Restart local-books app.',
		status: 401 as const,
	}),
	/** A bootstrap exchange arrived after the single-use token was consumed. */
	NoBootstrapToken: () => ({
		message: 'No bootstrap token is outstanding.',
		status: 401 as const,
	}),
	/** Exchange attempts exceeded the online-guessing bound. */
	TooManyExchanges: () => ({
		message: 'Too many exchange attempts.',
		status: 429 as const,
	}),
	/** The exchanged token did not match the outstanding bootstrap token. */
	InvalidBootstrapToken: () => ({
		message: 'Invalid bootstrap token.',
		status: 401 as const,
	}),
	/** A path parameter named a table the mirror does not hold. */
	UnknownTable: ({ table }: { table: string }) => ({
		message: `No table "${table}" in the mirror.`,
		status: 404 as const,
	}),
	/** No mirror row for the requested table id. */
	RowNotFound: () => ({
		message: 'Row not found.',
		status: 404 as const,
	}),
	/** A read-only SQL query failed (bad SQL, or a write refused by the connection). */
	QueryFailed: ({ message }: { message: string }) => ({
		message,
		status: 400 as const,
	}),
	/** A background/on-demand sync pass could not run. */
	SyncFailed: ({ message }: { message: string }) => ({
		message,
		status: 502 as const,
	}),
	/** A live QuickBooks report read failed upstream. */
	ReportFailed: ({ message }: { message: string }) => ({
		message,
		status: 502 as const,
	}),
	/**
	 * The one QuickBooks write-back was refused or failed. The core owns the
	 * refusal; the boundary only maps its `error.name` to the HTTP `status`
	 * (ReadOnly -> 403, NotInMirror -> 404, otherwise 400).
	 */
	RecategorizeFailed: ({
		message,
		status,
	}: {
		message: string;
		status: 400 | 403 | 404;
	}) => ({ message, status }),
	/** No route matched under `/api`. */
	NotFound: () => ({
		message: 'Not found.',
		status: 404 as const,
	}),
});

/** Discriminated union of all `/api` error payloads, keyed by `name`. */
export type ApiError = InferErrors<typeof ApiError>;
