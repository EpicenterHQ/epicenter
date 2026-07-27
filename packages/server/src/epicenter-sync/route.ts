import {
	DATA_ADDRESS_CEILINGS,
	isRowAddress,
	type RowAddress,
} from '@epicenter/data/protocol';
import { DOCUMENT_MAX_TRANSFER_BYTES } from '@epicenter/document-sync';
import type { PrincipalId } from '@epicenter/identity';
import { Hono, type MiddlewareHandler } from 'hono';

import type { Env } from '../types.js';
import type {
	DocumentAppendOutcome,
	DocumentReadOutcome,
} from './document-store.js';

export type DocumentPublishDispatch<E extends Env = Env> = (
	principalId: PrincipalId,
	address: RowAddress,
	update: Uint8Array,
	env: E['Bindings'],
) => DocumentAppendOutcome | Promise<DocumentAppendOutcome>;

export type DocumentPullDispatch<E extends Env = Env> = (
	principalId: PrincipalId,
	address: RowAddress,
	sinceVersion: number | undefined,
	env: E['Bindings'],
) => DocumentReadOutcome | Promise<DocumentReadOutcome>;

/**
 * Read a row address out of the URL path.
 *
 * The three coordinates are three path segments, so the route never parses or
 * splits a joined key. Hono has already percent-decoded each segment; the
 * address grammar then admits or refuses it.
 */
function addressFromPath(
	namespace: string,
	tableName: string,
	rowId: string,
): RowAddress | undefined {
	const candidate = { kind: 'row', namespace, tableName, rowId } as const;
	return isRowAddress(candidate, DATA_ADDRESS_CEILINGS) ? candidate : undefined;
}

function documentETag(version: number): string {
	return `"${version}"`;
}

function parseIfNoneMatch(header: string | undefined): number | undefined {
	const matched = header === undefined ? null : /^"(\d{1,15})"$/.exec(header);
	return matched === null ? undefined : Number(matched[1]);
}

/** Create the authenticated document publish and pull sub-app. */
export function createDocumentSyncApp<E extends Env = Env>({
	publish,
	pull,
}: {
	publish: DocumentPublishDispatch<E>;
	pull: DocumentPullDispatch<E>;
}): Hono<E> {
	const app = new Hono<E>();
	app.post('/api/sync/v1/documents/:namespace/:table/:rowId', async (c) => {
		const address = addressFromPath(
			c.req.param('namespace'),
			c.req.param('table'),
			c.req.param('rowId'),
		);
		if (address === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const declaredLength = Number(c.req.raw.headers.get('content-length'));
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > DOCUMENT_MAX_TRANSFER_BYTES
		) {
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		const body = new Uint8Array(await c.req.raw.arrayBuffer());
		if (body.byteLength === 0) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		if (body.byteLength > DOCUMENT_MAX_TRANSFER_BYTES) {
			return c.json({ error: 'request-too-large' } as const, 413);
		}
		const result = await publish(c.var.principal.id, address, body, c.env);
		if (result.outcome === 'invalid-update') {
			return c.json({ error: 'invalid-update' } as const, 400);
		}
		return c.json({ outcome: result.outcome } as const);
	});
	app.get('/api/sync/v1/documents/:namespace/:table/:rowId', async (c) => {
		const address = addressFromPath(
			c.req.param('namespace'),
			c.req.param('table'),
			c.req.param('rowId'),
		);
		if (address === undefined) {
			return c.json({ error: 'invalid-request' } as const, 400);
		}
		const sinceVersion = parseIfNoneMatch(c.req.header('if-none-match'));
		const result = await pull(c.var.principal.id, address, sinceVersion, c.env);
		if (result.kind === 'not-live') {
			return c.json({ error: 'not-live' } as const, 404);
		}
		const headers = { etag: documentETag(result.version) };
		if (result.kind === 'unchanged') {
			return c.body(null, 304, headers);
		}
		if (result.state === undefined) {
			return c.body(null, 204, headers);
		}
		return c.body(result.state.slice().buffer as ArrayBuffer, 200, {
			...headers,
			'content-type': 'application/octet-stream',
		});
	});
	return app;
}

/**
 * Mount the bearer-authenticated document synchronization ingress: POST
 * publishes one candidate into the authority acceptance operation, GET pulls
 * accepted state with a conditional version so unchanged documents transfer
 * no body (ADR-0174).
 */
export function mountDocumentSyncRoute<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		publish,
		pull,
	}: {
		auth: MiddlewareHandler<E>;
		publish: DocumentPublishDispatch<E>;
		pull: DocumentPullDispatch<E>;
	},
): void {
	app.use('/api/sync/v1/documents/:namespace/:table/:rowId', auth);
	app.route('/', createDocumentSyncApp<E>({ publish, pull }));
}
