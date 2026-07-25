import {
	DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
	DOCUMENT_PULL_STATUS,
	type DocumentAcceptance,
	type DocumentPull,
	documentVersionTag,
	encodeDocumentAcceptance,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import {
	parseAddress,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { DOCUMENT_FRAME_LIMITS } from '@epicenter/sync/document-v3';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import { readBoundedBody } from './scalar-v1-route.js';

export const DOCUMENT_V1_PUBLICATIONS_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/document-publications';
export const DOCUMENT_V1_PULL_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/document';
export {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
};

export type DocumentAuthorityV1Endpoint = {
	acceptDocument(
		request: NonNullable<ReturnType<typeof parseDocumentPublicationRequest>>,
	): DocumentAcceptance | Promise<DocumentAcceptance>;
	pullDocument(request: {
		authorityLifetime: string;
		address: { namespace: string; collection: string; recordKey: string };
		knownDocumentVersion: string | null;
	}): DocumentPull | Promise<DocumentPull>;
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

	app.get(DOCUMENT_V1_PULL_PATH, async (c) => {
		const authorityLifetime = c.req.header(DOCUMENT_LIFETIME_HEADER);
		const address = parseAddress(
			{
				namespace: c.req.param('namespace'),
				collection: c.req.param('collection'),
				recordKey: c.req.param('recordKey'),
			},
			limits,
		);
		if (authorityLifetime === undefined || address.error !== null) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const pull = await authority.pullDocument({
			authorityLifetime,
			address: address.data,
			knownDocumentVersion: knownVersion(c.req.header('if-none-match')),
		});
		return pullResponseFor(pull);
	});
	return app;
}

/**
 * Read one `If-None-Match` back into the version the replica already holds.
 *
 * Only a single strong validator is honored. Anything else (a list, `*`, a
 * weak tag) reads as "no known version", which costs one full body and can
 * never install stale state.
 */
function knownVersion(header: string | undefined): string | null {
	return header?.match(/^"([a-f0-9]{64})"$/)?.[1] ?? null;
}

/**
 * Answer one pull with exactly one meaning per status: bytes, no state yet,
 * still current, or a typed refusal decoded like a publication refusal.
 */
function pullResponseFor(pull: DocumentPull): Response {
	switch (pull.kind) {
		case 'record-not-live':
		case 'lifetime-mismatch':
			return new Response(encodeDocumentAcceptance(pull), {
				status: DOCUMENT_PULL_STATUS.refused,
				headers: { 'content-type': 'application/json' },
			});
		case 'absent':
			return new Response(null, {
				status: DOCUMENT_PULL_STATUS.absent,
				headers: {
					[DOCUMENT_LIFETIME_HEADER]: pull.activeAuthorityLifetime,
				},
			});
		case 'unchanged':
			return new Response(null, {
				status: DOCUMENT_PULL_STATUS.unchanged,
				headers: {
					[DOCUMENT_LIFETIME_HEADER]: pull.activeAuthorityLifetime,
					etag: documentVersionTag(pull.documentVersion),
				},
			});
		case 'state':
			return new Response(pull.update.slice().buffer as ArrayBuffer, {
				status: DOCUMENT_PULL_STATUS.state,
				headers: {
					'content-type': 'application/octet-stream',
					'cache-control': 'no-store',
					[DOCUMENT_LIFETIME_HEADER]: pull.activeAuthorityLifetime,
					etag: documentVersionTag(pull.documentVersion),
				},
			});
	}
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
	app.use(DOCUMENT_V1_PULL_PATH, auth);
	app.route('/', createDocumentV1App(options));
}
