import {
	type AdmittedFactsRequest,
	type AdmittedSubmissionRequest,
	type AuthorityError,
	type FactsResponse,
	parseFactsRequest,
	parseSubmissionRequest,
	type SubmissionResponse,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Result } from 'wellcrafted/result';

import type { Env } from '../types.js';

export const SCALAR_V1_FACTS_PATH = '/api/sync/v1/facts';
export const SCALAR_V1_SUBMISSIONS_PATH = '/api/sync/v1/submissions';

export type ScalarAuthorityV1Endpoint = {
	readFacts(
		request: AdmittedFactsRequest,
	):
		| Result<FactsResponse, AuthorityError>
		| Promise<Result<FactsResponse, AuthorityError>>;
	submit(
		request: AdmittedSubmissionRequest,
	):
		| Result<SubmissionResponse, AuthorityError>
		| Promise<Result<SubmissionResponse, AuthorityError>>;
};

export type ScalarAuthorityV1Locator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => ScalarAuthorityV1Endpoint | Promise<ScalarAuthorityV1Endpoint>;

export type ScalarV1RouteOptions<E extends Env = Env> = {
	locateAuthority: ScalarAuthorityV1Locator<E>;
	limits: ValidatedLimits;
	rawSubmissionBytes: number;
};

function parseAfterSequence(value: string | null): number | undefined {
	if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function factsRequestFromUrl(
	url: URL,
	limits: ValidatedLimits,
): AdmittedFactsRequest | undefined {
	const keys = [...url.searchParams.keys()];
	if (
		keys.some(
			(key) => key !== 'authorityLifetime' && key !== 'afterSequence',
		) ||
		url.searchParams.getAll('afterSequence').length !== 1 ||
		url.searchParams.getAll('authorityLifetime').length > 1
	) {
		return undefined;
	}
	const afterSequence = parseAfterSequence(
		url.searchParams.get('afterSequence'),
	);
	if (afterSequence === undefined) return undefined;
	const authorityLifetime = url.searchParams.get('authorityLifetime');
	const parsed = parseFactsRequest(
		{
			...(authorityLifetime === null ? {} : { authorityLifetime }),
			afterSequence,
		},
		limits,
	);
	return parsed.error === null ? parsed.data : undefined;
}

export async function readBoundedBody(
	request: Request,
	maximumBytes: number,
): Promise<
	| { ok: true; bytes: Uint8Array }
	| { ok: false; reason: 'invalid-length' | 'too-large' }
> {
	const declared = request.headers.get('content-length');
	if (declared !== null) {
		if (!/^(0|[1-9][0-9]*)$/.test(declared)) {
			return { ok: false, reason: 'invalid-length' };
		}
		const parsed = Number(declared);
		if (!Number.isSafeInteger(parsed)) {
			return { ok: false, reason: 'invalid-length' };
		}
		if (parsed > maximumBytes) {
			return { ok: false, reason: 'too-large' };
		}
	}
	if (request.body === null) return { ok: true, bytes: new Uint8Array() };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for (;;) {
		const part = await reader.read();
		if (part.done) break;
		bytes += part.value.byteLength;
		if (bytes > maximumBytes) {
			await reader.cancel();
			return { ok: false, reason: 'too-large' };
		}
		chunks.push(part.value);
	}
	const body = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes: body };
}

function authorityErrorResponse(error: AuthorityError): Response {
	switch (error.name) {
		case 'LifetimeMismatch':
			return Response.json(
				{
					error: 'lifetime-mismatch',
					activeAuthorityLifetime: error.active,
				},
				{ status: 409 },
			);
		case 'SequenceAhead':
			return Response.json(
				{
					error: 'sequence-ahead',
					activeSequence: error.activeSequence,
				},
				{ status: 409 },
			);
		case 'SubmissionFork':
			return Response.json(
				{
					error: 'submission-fork',
					submissionNumber: error.submissionNumber,
				},
				{ status: 409 },
			);
		case 'SubmissionGap':
			return Response.json(
				{
					error: 'submission-gap',
					expectedSubmissionNumber: error.expectedNumber,
				},
				{ status: 409 },
			);
		case 'SequenceExhausted':
			return Response.json({ error: 'sequence-exhausted' }, { status: 409 });
	}
}

/** Create the two scalar V1 routes without mounting authentication. */
export function createScalarV1App<E extends Env = Env>({
	locateAuthority,
	limits,
	rawSubmissionBytes,
}: ScalarV1RouteOptions<E>): Hono<E> {
	const app = new Hono<E>();

	app.get(SCALAR_V1_FACTS_PATH, async (c) => {
		const request = factsRequestFromUrl(new URL(c.req.url), limits);
		if (request === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const result = await authority.readFacts(request);
		return result.error === null
			? c.json(result.data)
			: authorityErrorResponse(result.error);
	});

	app.post(SCALAR_V1_SUBMISSIONS_PATH, async (c) => {
		const body = await readBoundedBody(c.req.raw, rawSubmissionBytes);
		if (!body.ok) {
			if (body.reason === 'invalid-length') {
				return c.json({ error: 'invalid-request' } as const, 400);
			}
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		let value: unknown;
		try {
			value = JSON.parse(
				new TextDecoder('utf-8', { fatal: true }).decode(body.bytes),
			);
		} catch {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const parsed = parseSubmissionRequest(value, limits);
		if (parsed.error !== null) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const result = await authority.submit(parsed.data);
		return result.error === null
			? c.json(result.data)
			: authorityErrorResponse(result.error);
	});

	return app;
}

/** Mount both scalar V1 routes behind the deployment's bearer gate. */
export function mountScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		...options
	}: ScalarV1RouteOptions<E> & { auth: MiddlewareHandler<E> },
): void {
	app.use(SCALAR_V1_FACTS_PATH, auth);
	app.use(SCALAR_V1_SUBMISSIONS_PATH, auth);
	app.route('/', createScalarV1App(options));
}
