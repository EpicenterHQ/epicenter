import {
	parseAddress,
	parseFactsRequest,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { parseSubprotocols } from '@epicenter/sync';
import { DOCUMENT_SUBPROTOCOL } from '@epicenter/sync/document-v3';
import type { Context } from 'hono';

import { extractUpgradeBearer } from '../auth/extract-upgrade-bearer.js';
import type { Env, ResolveDocumentPrincipal } from '../types.js';

export const DOCUMENT_V1_REALTIME_PATH =
	'/api/sync/v1/records/:namespace/:collection/:recordKey/document';

/** Authenticate and admit the complete identity of one document V1 socket. */
export async function resolveDocumentRealtimeV1Upgrade<E extends Env>(
	c: Context<E>,
	resolvePrincipal: ResolveDocumentPrincipal<E>,
) {
	if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return undefined;
	const protocols = parseSubprotocols(
		c.req.header('sec-websocket-protocol') ?? null,
	);
	if (!protocols.includes(DOCUMENT_SUBPROTOCOL)) return undefined;
	const bearer = extractUpgradeBearer(c.req.raw.headers);
	if (bearer === null) return undefined;
	const authorization = await resolvePrincipal(c, bearer);
	if (authorization.error !== null) return undefined;

	const url = new URL(c.req.url);
	if (
		[...url.searchParams.keys()].some((key) => key !== 'authorityLifetime') ||
		url.searchParams.getAll('authorityLifetime').length !== 1
	) {
		return undefined;
	}
	const authorityLifetime = url.searchParams.get('authorityLifetime');
	if (authorityLifetime === null) return undefined;
	const lifetime = parseFactsRequest(
		{
			authorityLifetime,
			afterSequence: 0,
		},
		SCALAR_SYNC_V1_LIMITS,
	);
	const address = parseAddress(
		{
			namespace: c.req.param('namespace'),
			collection: c.req.param('collection'),
			recordKey: c.req.param('recordKey'),
		},
		SCALAR_SYNC_V1_LIMITS,
	);
	if (lifetime.error !== null || address.error !== null) return undefined;
	return {
		principalId: authorization.data.principal.id,
		authorizationExpiresAt: authorization.data.authorizationExpiresAt,
		authorityLifetime,
		address: address.data,
	};
}
