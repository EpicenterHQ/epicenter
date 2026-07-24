import {
	type BlobAcceptance,
	parseBlobPublicationRequest,
} from '@epicenter/data/blob-v1';
import {
	parseAddress,
	type RecordAddress,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';

export const BLOB_V1_PUBLICATIONS_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/blob-publications';
export const BLOB_V1_BYTES_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/blob';
export const BLOB_LIFETIME_HEADER = 'x-epicenter-authority-lifetime';
export const BLOB_PROTOCOL_HEADER = 'x-epicenter-blob-protocol';
export const BLOB_DIGEST_HEADER = 'x-epicenter-blob-digest';

export type BlobAuthorityV1Endpoint = {
	accept(
		request: NonNullable<ReturnType<typeof parseBlobPublicationRequest>>,
		bytes: ReadableStream<Uint8Array>,
	): Promise<BlobAcceptance>;
	read(address: RecordAddress): Promise<ReadableStream<Uint8Array> | undefined>;
};

export type BlobAuthorityV1Locator<E extends Env = Env> = (
	principalId: PrincipalId,
	env: E['Bindings'],
) => BlobAuthorityV1Endpoint | Promise<BlobAuthorityV1Endpoint>;

function responseFor(result: BlobAcceptance): Response {
	return Response.json(result, {
		status: result.kind === 'accepted' ? 200 : 409,
	});
}

function addressFrom(
	params: { namespace: string; collection: string; recordKey: string },
	limits: ValidatedLimits,
): RecordAddress | undefined {
	const parsed = parseAddress(params, limits);
	return parsed.error === null ? parsed.data : undefined;
}

/** Create record-addressed streaming blob routes without auth. */
export function createBlobV1App<E extends Env = Env>({
	locateAuthority,
	limits,
}: {
	locateAuthority: BlobAuthorityV1Locator<E>;
	limits: ValidatedLimits;
}): Hono<E> {
	const app = new Hono<E>();
	app.post(BLOB_V1_PUBLICATIONS_PATH, async (c) => {
		if (c.req.header('content-type') !== 'application/octet-stream') {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const bytes = c.req.raw.body;
		if (bytes === null)
			return c.json({ error: 'invalid-request' } as const, 400);
		const request = parseBlobPublicationRequest(
			{
				authorityLifetime: c.req.header(BLOB_LIFETIME_HEADER),
				address: {
					namespace: c.req.param('namespace'),
					collection: c.req.param('collection'),
					recordKey: c.req.param('recordKey'),
				},
				protocolVersion: c.req.header(BLOB_PROTOCOL_HEADER),
				digest: c.req.header(BLOB_DIGEST_HEADER),
			},
			limits,
		);
		if (request === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		return responseFor(await authority.accept(request, bytes));
	});
	app.get(BLOB_V1_BYTES_PATH, async (c) => {
		const address = addressFrom(
			{
				namespace: c.req.param('namespace'),
				collection: c.req.param('collection'),
				recordKey: c.req.param('recordKey'),
			},
			limits,
		);
		if (address === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const authority = await locateAuthority(c.var.principal.id, c.env);
		const bytes = await authority.read(address);
		return bytes === undefined
			? c.json({ error: 'not-found' } as const, 404)
			: new Response(bytes, {
					headers: { 'content-type': 'application/octet-stream' },
				});
	});
	return app;
}

/** Mount record blob routes behind the deployment bearer gate. */
export function mountBlobV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		...options
	}: {
		auth: MiddlewareHandler<E>;
		locateAuthority: BlobAuthorityV1Locator<E>;
		limits: ValidatedLimits;
	},
): void {
	app.use(BLOB_V1_PUBLICATIONS_PATH, auth);
	app.use(BLOB_V1_BYTES_PATH, auth);
	app.route('/', createBlobV1App(options));
}
