/**
 * The HTTP carrier for the two scalar V1 operations (ADR-0163).
 *
 *     GET  <deployment>/api/sync/v1/facts?afterSequence=&authorityLifetime=
 *     POST <deployment>/api/sync/v1/submissions
 *
 * One implementation for every caller. Before this, each app hand-rolled its
 * own `fetch` against the combined exchange and re-derived which statuses meant
 * what, so a status the authority used to mean "your replica is superseded"
 * could be read as "the network is unhappy" in one app and not another.
 *
 * The split this module owns is the one the replica cannot make for itself:
 * telling an authority refusal apart from a transport failure. A refusal comes
 * back as a value the replica maps to a typed terminal or corruption error; a
 * network fault, a 5xx, or an unreadable body throws, which the replica reports
 * as `TransportFailed` and retries with backoff. Getting that backwards is what
 * turns a terminal lifetime mismatch into a hot retry loop.
 *
 * Response bodies are returned unparsed. Only the kernel's context-aware
 * admission may decide a response is usable, because that needs the sealed
 * request and durable replica state; a transport that validated bodies would be
 * a second, weaker protocol boundary.
 */

import type { FactsRequest, SubmissionRequest } from './protocol/v1/index.js';
import type {
	AuthorityRefusal,
	ScalarTransport,
	TransportOutcome,
} from './replica/v1-replica.js';

/** The `fetch` shape this carrier needs, so a caller can supply an authorized one. */
export type SyncFetch = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<Response>;

export type HttpScalarTransportOptions = {
	/** The deployment origin, for example `https://api.epicenter.so/`. */
	baseUrl: string;
	/** Usually an auth-owned fetch that attaches the bearer token. */
	fetch: SyncFetch;
};

/**
 * The refusal codes the route emits, as a closed set.
 *
 * Anything else with a refusal status is treated as a transport failure rather
 * than silently mapped to the nearest known code: inventing a recovery for an
 * outcome this client does not understand is how a replica ends up erasing
 * itself on a proxy's error page.
 */
const REFUSAL_CODES = new Set([
	'lifetime-mismatch',
	'sequence-ahead',
	'submission-fork',
	'submission-gap',
	'storage-limit',
]);

function toRefusal(body: unknown): AuthorityRefusal | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const record = body as Record<string, unknown>;
	const code = record.error;
	if (typeof code !== 'string' || !REFUSAL_CODES.has(code)) return undefined;
	if (code === 'lifetime-mismatch') {
		const activeLifetime = record.activeLifetime;
		if (typeof activeLifetime !== 'string') return undefined;
		return { code: 'lifetime-mismatch', activeLifetime };
	}
	return { code } as AuthorityRefusal;
}

/**
 * Turn one HTTP response into a transport outcome.
 *
 * A 2xx is a response body. A refusal status carrying a code this client knows
 * is a refusal value. Everything else throws, including a refusal status whose
 * body is unrecognizable, so the replica retries rather than acting on a
 * recovery it inferred from a stranger's error page.
 */
async function readOutcome(
	response: Response,
	operation: 'facts' | 'submissions',
): Promise<TransportOutcome> {
	if (response.ok) {
		return { kind: 'response', body: (await response.json()) as unknown };
	}
	if (response.status === 409 || response.status === 503) {
		const body = await response.json().catch(() => undefined);
		const refusal = toRefusal(body);
		if (refusal !== undefined) return { kind: 'refused', refusal };
	}
	throw new Error(
		`Scalar ${operation} request failed with status ${response.status}`,
	);
}

/** Build the shared HTTP carrier for one deployment. */
export function createHttpScalarTransport({
	baseUrl,
	fetch,
}: HttpScalarTransportOptions): ScalarTransport {
	const factsUrl = new URL('api/sync/v1/facts', baseUrl);
	const submissionsUrl = new URL('api/sync/v1/submissions', baseUrl).toString();

	return {
		async readFacts(request: FactsRequest): Promise<TransportOutcome> {
			const url = new URL(factsUrl);
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			return readOutcome(await fetch(url.toString()), 'facts');
		},

		async submit(request: SubmissionRequest): Promise<TransportOutcome> {
			const response = await fetch(submissionsUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
			});
			return readOutcome(response, 'submissions');
		},
	};
}
