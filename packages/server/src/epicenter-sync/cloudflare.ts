import { DurableObject } from 'cloudflare:workers';

import {
	type ExchangeRequest,
	type ExchangeResponse,
	parseExchangeRequest,
	parseExchangeResponse,
} from '@epicenter/data/protocol';
import {
	DOCUMENT_SUBPROTOCOL,
	type DocumentAddress,
} from '@epicenter/document-sync';
import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import type { Hono, MiddlewareHandler } from 'hono';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { openEpicenterSyncAuthority } from './authority.js';
import {
	createEpicenterDocumentServer,
	type EpicenterDocumentSocket,
} from './document-server.js';
import {
	mountEpicenterSyncRoute,
	resolveEpicenterDocumentUpgrade,
} from './route.js';

const INTERNAL_DOCUMENT_PATH = '/document';
const ADDRESS_NAMESPACE_HEADER = 'x-epicenter-document-namespace';
const ADDRESS_TABLE_HEADER = 'x-epicenter-document-table';
const ADDRESS_ROW_HEADER = 'x-epicenter-document-row';
const AUTHORIZATION_EXPIRES_HEADER = 'x-epicenter-authorization-expires-at';
const ORDINARY_CLOSE_CODE = 1000;

type DocumentAttachment = {
	version: 1;
	subprotocol: string;
	address: DocumentAddress;
	authorizationExpiresAt: number;
};

function isDocumentAttachment(value: unknown): value is DocumentAttachment {
	if (value === null || typeof value !== 'object') return false;
	const attachment = value as Partial<DocumentAttachment>;
	return (
		attachment.version === 1 &&
		typeof attachment.subprotocol === 'string' &&
		typeof attachment.address?.namespace === 'string' &&
		typeof attachment.address.table === 'string' &&
		typeof attachment.address.rowId === 'string' &&
		typeof attachment.authorizationExpiresAt === 'number'
	);
}

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

function responseJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json; charset=UTF-8' },
	});
}

/** One principal-owned Epicenter authority in Durable Object SQLite. */
export class EpicenterAuthority extends DurableObject {
	private readonly scalar;
	private readonly documents;
	private readonly sockets = new WeakMap<WebSocket, EpicenterDocumentSocket>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const database = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.scalar = openEpicenterSyncAuthority({
			database,
			readDatabaseSize: () =>
				(ctx.storage as unknown as { sql: { databaseSize: number } }).sql
					.databaseSize,
		});
		this.documents = createEpicenterDocumentServer({ database });

		for (const socket of ctx.getWebSockets()) {
			if (socket.readyState === WebSocket.OPEN) {
				socket.close(ORDINARY_CLOSE_CODE, 'restart-resync');
			}
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST') return this.exchange(request);
		if (request.method === 'GET' && url.pathname === INTERNAL_DOCUMENT_PATH) {
			return this.acceptDocument(request);
		}
		return new Response(null, { status: 404 });
	}

	override webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): void {
		const attachment = socket.deserializeAttachment();
		if (!isDocumentAttachment(attachment)) {
			socket.close(1011, 'invalid-document-attachment');
			return;
		}
		if (attachment.subprotocol !== DOCUMENT_SUBPROTOCOL) {
			socket.close(ORDINARY_CLOSE_CODE, 'stale-subprotocol');
			return;
		}
		if (Date.now() >= attachment.authorizationExpiresAt) {
			this.documents.disconnect(this.socket(socket));
			socket.close(ORDINARY_CLOSE_CODE, 'credential-expired');
			return;
		}
		if (typeof message === 'string') {
			socket.close(1002, 'invalid-document-frame');
			return;
		}
		this.documents.receive(
			this.socket(socket),
			attachment.address,
			new Uint8Array(message),
		);
	}

	override webSocketClose(socket: WebSocket): void {
		this.documents.disconnect(this.socket(socket));
	}

	override webSocketError(socket: WebSocket): void {
		this.webSocketClose(socket);
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		let nextExpiry: number | undefined;
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			const attachment = socket.deserializeAttachment();
			if (!isDocumentAttachment(attachment)) continue;
			if (attachment.authorizationExpiresAt <= now) {
				this.documents.disconnect(this.socket(socket));
				socket.close(ORDINARY_CLOSE_CODE, 'credential-expired');
			} else {
				nextExpiry = Math.min(
					nextExpiry ?? attachment.authorizationExpiresAt,
					attachment.authorizationExpiresAt,
				);
			}
		}
		if (nextExpiry === undefined) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(nextExpiry);
	}

	/** Delete every scalar and document byte owned by this principal authority. */
	async deleteAccount(): Promise<void> {
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			this.documents.disconnect(this.socket(socket));
			socket.close(ORDINARY_CLOSE_CODE, 'not-live');
		}
		await this.ctx.storage.deleteAll();
	}

	private async exchange(request: Request): Promise<Response> {
		try {
			const parsed = parseExchangeRequest(JSON.parse(await request.text()));
			if (parsed.error !== null) throw new TypeError(parsed.error.message);
			const exchangeRequest = parsed.data;
			const response = this.scalar.exchange(exchangeRequest);
			if (!('refusal' in response) && exchangeRequest.batch !== undefined) {
				for (const change of exchangeRequest.batch.changes) {
					if (change.kind === 'delete') {
						this.documents.closeRow({
							namespace: change.namespace,
							table: change.table,
							rowId: change.rowId,
						});
					}
				}
			}
			return responseJson(response);
		} catch (cause) {
			if (cause instanceof SyntaxError || cause instanceof TypeError) {
				return responseJson({ error: 'invalid-request' }, 400);
			}
			throw cause;
		}
	}

	private async acceptDocument(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 426 });
		}
		if (
			request.headers.get('sec-websocket-protocol') !== DOCUMENT_SUBPROTOCOL
		) {
			return new Response(null, { status: 400 });
		}
		const namespace = request.headers.get(ADDRESS_NAMESPACE_HEADER);
		const table = request.headers.get(ADDRESS_TABLE_HEADER);
		const rowId = request.headers.get(ADDRESS_ROW_HEADER);
		const authorizationExpiresAt = Number(
			request.headers.get(AUTHORIZATION_EXPIRES_HEADER),
		);
		if (
			namespace === null ||
			table === null ||
			rowId === null ||
			!Number.isSafeInteger(authorizationExpiresAt) ||
			authorizationExpiresAt <= Date.now()
		) {
			return new Response(null, { status: 400 });
		}
		const address = { namespace, table, rowId };
		if (!this.documents.admit(address)) {
			return new Response(null, { status: 404 });
		}

		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm === null || authorizationExpiresAt < currentAlarm) {
			await this.ctx.storage.setAlarm(authorizationExpiresAt);
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		const attachment: DocumentAttachment = {
			version: 1,
			subprotocol: DOCUMENT_SUBPROTOCOL,
			address,
			authorizationExpiresAt,
		};
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { 'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL },
		});
	}

	private socket(socket: WebSocket): EpicenterDocumentSocket {
		let adapter = this.sockets.get(socket);
		if (adapter === undefined) {
			adapter = {
				send: (data) => socket.send(data),
				close: () => socket.close(),
			};
			this.sockets.set(socket, adapter);
		}
		return adapter;
	}
}

type EpicenterAuthorityNamespace = DurableObjectNamespace<EpicenterAuthority>;

type DeletableAuthorityNamespace = {
	getByName(name: string): { deleteAccount(): Promise<void> };
};

function stubFor(
	namespace: EpicenterAuthorityNamespace,
	principalId: PrincipalId,
) {
	return namespace.getByName(principalName(principalId));
}

/**
 * Preserve the hosted account-deletion caller while its route remains outside
 * this cutover wave. The caller supplies the namespace it intends to sweep.
 */
export function createDurableObjectAccountAuthorities(
	namespace: DeletableAuthorityNamespace,
) {
	return {
		authority(principalId: PrincipalId) {
			return {
				deleteAccount: () =>
					namespace.getByName(principalName(principalId)).deleteAccount(),
			};
		},
	};
}

async function exchangeThroughDurableObject(
	namespace: EpicenterAuthorityNamespace,
	principalId: PrincipalId,
	request: ExchangeRequest,
): Promise<ExchangeResponse> {
	const response = await stubFor(namespace, principalId).fetch(
		new Request('https://epicenter-authority.internal/', {
			method: 'POST',
			body: JSON.stringify(request),
		}),
	);
	if (!response.ok) throw new TypeError('Epicenter authority refused exchange');
	const parsed = parseExchangeResponse(await response.json());
	if (parsed.error !== null) throw new TypeError(parsed.error.message);
	return parsed.data;
}

/** Mount the Cloudflare scalar exchange and row-document WebSocket route. */
export function mountCloudflareEpicenterSyncApp<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveDocumentPrincipal,
		resolveNamespace,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
		resolveNamespace(env: E['Bindings']): EpicenterAuthorityNamespace;
	},
): void {
	mountEpicenterSyncRoute(app, {
		auth,
		locateAuthority: (principalId, env) => (request) =>
			exchangeThroughDurableObject(resolveNamespace(env), principalId, request),
	});
	app.get('/api/sync/v1/documents/:namespace/:table/:rowId', async (c) => {
		const authorization = await resolveEpicenterDocumentUpgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (authorization === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		const headers = new Headers({
			upgrade: 'websocket',
			'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL,
			[ADDRESS_NAMESPACE_HEADER]: authorization.address.namespace,
			[ADDRESS_TABLE_HEADER]: authorization.address.table,
			[ADDRESS_ROW_HEADER]: authorization.address.rowId,
			[AUTHORIZATION_EXPIRES_HEADER]: String(
				authorization.authorizationExpiresAt,
			),
		});
		return stubFor(resolveNamespace(c.env), authorization.principalId).fetch(
			new Request(
				`https://epicenter-authority.internal${INTERNAL_DOCUMENT_PATH}`,
				{
					headers,
				},
			),
		);
	});
}
