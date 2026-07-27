/**
 * The two scalar V1 wire operations (ADR-0163).
 *
 *     GET  /api/sync/v1/facts        reads current authority facts
 *     POST /api/sync/v1/submissions  submits numbered desired-state intents
 *
 * They are separate routes because they are separate operations with different
 * identities and retry cadences, not two phases of one exchange. Neither is a
 * public sync control: applications only make typed local reads and writes, and
 * the runtime drives these.
 *
 * Row documents remain a separate synchronization plane on their own routes
 * under `/api/sync/v1/documents/...`; nothing here touches them.
 */

import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../types.js';
import type { EpicenterSyncV1Authority } from './v1-authority.js';

/**
 * The raw body ceiling, applied before parsing.
 *
 * This is a cheap denial-of-service guard, not semantic admission: the kernel's
 * `parseSubmissionRequest` still measures the canonical encoding against
 * `maxSubmissionBytes`. Sized above the V1 submission ceiling so a legitimate
 * maximum submission is never refused here rather than by the protocol.
 */
const MAX_SUBMISSION_REQUEST_BYTES = 2 * 1024 * 1024;

/**
 * The authority as this route calls it.
 *
 * Both operations may answer asynchronously, because one real carrier does: the
 * Cloudflare authority lives behind a Durable Object stub, so every RPC returns
 * a promise even though the underlying implementation is synchronous. Typing
 * these as synchronous would compile against the in-process Bun authority and
 * then silently destructure a pending promise into `undefined` on Workers.
 */
export type V1AuthorityCalls = {
	readFacts(
		request: unknown,
	): Awaitable<ReturnType<EpicenterSyncV1Authority['readFacts']>>;
	submit(
		request: unknown,
	): Awaitable<ReturnType<EpicenterSyncV1Authority['submit']>>;
};

type Awaitable<T> = T | Promise<T>;

export type V1AuthorityLocator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => Awaitable<V1AuthorityCalls>;

/**
 * Map an authority refusal onto a status and a stable machine-readable code.
 *
 * Every one of these is an expected protocol outcome with its own recovery, so
 * each keeps its own code rather than collapsing into a generic 400. The replica
 * turns these back into typed errors, which is what stops a terminal lifetime
 * mismatch from being retried like a transient network failure.
 *
 * 409 is the honest status for all four: the request was well formed, and the
 * authority's current state is what refuses it.
 */
function refusalResponse(error: { name: string; [key: string]: unknown }): {
	status: 400 | 409 | 503;
	body: Record<string, unknown>;
} {
	switch (error.name) {
		case 'LifetimeMismatch':
			return {
				status: 409,
				body: { error: 'lifetime-mismatch', activeLifetime: error.active },
			};
		case 'SequenceAhead':
			return { status: 409, body: { error: 'sequence-ahead' } };
		case 'SubmissionFork':
			return { status: 409, body: { error: 'submission-fork' } };
		case 'SubmissionGap':
			return { status: 409, body: { error: 'submission-gap' } };
		case 'SequenceExhausted':
			// The authority cannot assign another JSON-safe sequence. Not the
			// caller's fault and not retryable by them, but not a bug either.
			return { status: 503, body: { error: 'sequence-exhausted' } };
		default:
			// Anything else is a protocol admission failure: malformed input.
			return { status: 400, body: { error: 'invalid-request' } };
	}
}

/**
 * Read `afterSequence` out of the query string.
 *
 * Returned as `undefined` for anything that is not a bare non-negative decimal
 * integer. A query value is text, so this is the one place the wire's
 * JSON-safe positive integer has to be reconstructed; letting `Number()` accept
 * `1e3`, `0x10`, ` 1 `, or `1.0` would hand the protocol parser a value the
 * client never wrote.
 */
function parseAfterSequence(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^\d{1,16}$/.test(raw)) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) ? value : undefined;
}

/** Create the authenticated scalar V1 sub-app without mounting it. */
export function createEpicenterSyncV1App<E extends Env = Env>(
	locateAuthority: V1AuthorityLocator<E>,
): Hono<E> {
	const app = new Hono<E>();

	app.get('/api/sync/v1/facts', async (c) => {
		const afterSequence = parseAfterSequence(c.req.query('afterSequence'));
		if (afterSequence === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authorityLifetime = c.req.query('authorityLifetime');
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const { data, error } = await authority.readFacts({
			...(authorityLifetime === undefined ? {} : { authorityLifetime }),
			afterSequence,
		});
		if (error !== null) {
			const { status, body } = refusalResponse(error);
			return c.json(body, status);
		}
		return c.json(data);
	});

	app.post('/api/sync/v1/submissions', async (c) => {
		const declaredLength = Number(c.req.raw.headers.get('content-length'));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > MAX_SUBMISSION_REQUEST_BYTES
		) {
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		let payload: unknown;
		try {
			const text = await c.req.raw.text();
			if (
				new TextEncoder().encode(text).byteLength > MAX_SUBMISSION_REQUEST_BYTES
			) {
				return c.json({ error: 'request-too-large' } as const, 413);
			}
			payload = JSON.parse(text);
		} catch (cause) {
			// Reading and decoding the body is the only part of this handler whose
			// failure is the caller's fault, so it is the only part this translation
			// covers. Anything else, including a bug or a storage failure inside the
			// authority below, must reach Hono's error boundary as a 500 rather than
			// be reported as invalid input.
			if (cause instanceof SyntaxError || cause instanceof TypeError) {
				return c.json({ error: 'invalid-request' } as const, 400);
			}
			throw cause;
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const { data, error } = await authority.submit(payload);
		if (error !== null) {
			const { status, body } = refusalResponse(error);
			return c.json(body, status);
		}
		return c.json(data);
	});

	return app;
}

/** Mount the bearer-authenticated scalar V1 operations. */
export function mountEpicenterSyncV1Route<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		locateAuthority,
	}: {
		auth: MiddlewareHandler<E>;
		locateAuthority: V1AuthorityLocator<E>;
	},
): void {
	app.use('/api/sync/v1/facts', auth);
	app.use('/api/sync/v1/submissions', auth);
	app.route('/', createEpicenterSyncV1App<E>(locateAuthority));
}
