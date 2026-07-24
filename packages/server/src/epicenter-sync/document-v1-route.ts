import {
	DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
	type DocumentAcceptance,
	encodeDocumentAcceptance,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import type { ValidatedLimits } from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { DOCUMENT_FRAME_LIMITS } from '@epicenter/sync/document-v3';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { readBoundedBody } from './scalar-v1-route.js';

export const DOCUMENT_V1_PUBLICATIONS_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/document-publications';
export const DOCUMENT_LIFETIME_HEADER = 'x-epicenter-authority-lifetime';
export const DOCUMENT_PROTOCOL_HEADER = 'x-epicenter-document-protocol';
export const DOCUMENT_DIGEST_HEADER = 'x-epicenter-document-digest';

export type DocumentAuthorityV1Endpoint = {
	acceptDocument(
		request: NonNullable<ReturnType<typeof parseDocumentPublicationRequest>>,
	): DocumentAcceptance | Promise<DocumentAcceptance>;
};

export type DocumentAuthorityV1Locator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => DocumentAuthorityV1Endpoint | Promise<DocumentAuthorityV1Endpoint>;

/**
 * Accepted publications answer 200; every typed refusal answers the one
 * conflict status carriers decode (`readDocumentAcceptance`). Refusals are
 * conflicts with authority state, so they carry a body, not a transport fault.
 */
function responseFor(result: DocumentAcceptance): Response {
	return new Response(encodeDocumentAcceptance(result), {
		status:
			result.kind === 'accepted' ? 200 : DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
		headers: { 'content-type': 'application/json' },
	});
}

/** Create the bounded binary document-publication route without auth. */
export function createDocumentV1App<E extends Env = Env>({
	locateAuthority,
	limits,
}: {
	locateAuthority: DocumentAuthorityV1Locator<E>;
	limits: ValidatedLimits;
}): Hono<E> {
	const app = new Hono<E>();
	app.post(DOCUMENT_V1_PUBLICATIONS_PATH, async (c) => {
		if (c.req.header('content-type') !== 'application/octet-stream') {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const body = await readBoundedBody(
			c.req.raw,
			DOCUMENT_FRAME_LIMITS.payloadBytes,
		);
		if (!body.ok) {
			return body.reason === 'too-large'
				? c.json({ error: 'request-too-large' } as const, 413)
				: c.json({ error: 'invalid-request' } as const, 400);
		}
		const request = parseDocumentPublicationRequest(
			{
				authorityLifetime: c.req.header(DOCUMENT_LIFETIME_HEADER),
				address: {
					namespace: c.req.param('namespace'),
					collection: c.req.param('collection'),
					recordKey: c.req.param('recordKey'),
				},
				protocolVersion: c.req.header(DOCUMENT_PROTOCOL_HEADER),
				payload: body.bytes,
				digest: c.req.header(DOCUMENT_DIGEST_HEADER),
			},
			limits,
		);
		if (request === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		return responseFor(await authority.acceptDocument(request));
	});
	return app;
}

/** Mount the document publication route behind the deployment bearer gate. */
export function mountDocumentV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		...options
	}: {
		auth: MiddlewareHandler<E>;
		locateAuthority: DocumentAuthorityV1Locator<E>;
		limits: ValidatedLimits;
	},
): void {
	app.use(DOCUMENT_V1_PUBLICATIONS_PATH, auth);
	app.route('/', createDocumentV1App(options));
}
