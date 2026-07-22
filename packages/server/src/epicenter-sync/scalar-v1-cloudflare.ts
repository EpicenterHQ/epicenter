import { DurableObject } from 'cloudflare:workers';

import {
	type DocumentAcceptance,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import {
	type AuthorityError,
	type FactsResponse,
	parseAddress,
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
	type SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { DOCUMENT_SUBPROTOCOL } from '@epicenter/sync/document-v3';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Result } from 'wellcrafted/result';

import type { Env, ResolveDocumentPrincipal } from '../types.js';
import { type DataAuthorityV1, openScalarAuthorityV1 } from './authority-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';
import {
	DOCUMENT_V1_REALTIME_PATH,
	resolveDocumentRealtimeV1Upgrade,
} from './document-realtime-v1-route.js';
import {
	type DocumentAuthorityV1Endpoint,
	mountDocumentV1App,
} from './document-v1-route.js';
import {
	mountScalarV1App,
	type ScalarAuthorityV1Endpoint,
} from './scalar-v1-route.js';

const INTERNAL_DOCUMENT_REALTIME_PATH = '/document-v1';
const ADDRESS_NAMESPACE_HEADER = 'x-epicenter-document-namespace';
const ADDRESS_COLLECTION_HEADER = 'x-epicenter-document-collection';
const ADDRESS_RECORD_HEADER = 'x-epicenter-document-record';
const AUTHORITY_LIFETIME_HEADER = 'x-epicenter-authority-lifetime';
const AUTHORIZATION_EXPIRES_HEADER = 'x-epicenter-authorization-expires-at';

type DataDocumentAttachment = {
	version: 1;
	protocol: typeof DOCUMENT_SUBPROTOCOL;
	address: {
		namespace: string;
		collection: string;
		recordKey: string;
	};
	authorityLifetime: string;
	authorizationExpiresAt: number;
};

function isDataDocumentAttachment(
	value: unknown,
): value is DataDocumentAttachment {
	if (value === null || typeof value !== 'object') return false;
	const attachment = value as Partial<DataDocumentAttachment>;
	return (
		attachment.version === 1 &&
		attachment.protocol === DOCUMENT_SUBPROTOCOL &&
		typeof attachment.address?.namespace === 'string' &&
		typeof attachment.address.collection === 'string' &&
		typeof attachment.address.recordKey === 'string' &&
		typeof attachment.authorityLifetime === 'string' &&
		typeof attachment.authorizationExpiresAt === 'number'
	);
}

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

/** One principal-owned scalar V1 authority on Durable Object SQLite. */
export class DataAuthority extends DurableObject<Cloudflare.Env> {
	private authority: DataAuthorityV1 | undefined;
	private realtime: DocumentRealtimeV1Server | undefined;
	private readonly sockets = new WeakMap<WebSocket, DocumentRealtimeV1Socket>();
	private initializationError: unknown;
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.ready = ctx.blockConcurrencyWhile(async () => {
			try {
				this.authority = this.openFreshOwner();
				this.realtime = createDocumentRealtimeV1Server({
					authority: this.authority,
				});
				for (const socket of ctx.getWebSockets()) {
					const attachment = socket.deserializeAttachment();
					if (!isDataDocumentAttachment(attachment)) {
						socket.close(1011, 'invalid-document-attachment');
						continue;
					}
					this.realtime.restore(
						this.socket(socket),
						attachment.address,
						attachment.authorityLifetime,
					);
				}
			} catch (cause) {
				// Keep the actor reachable for account deletion. A rejected constructor
				// block prevents later RPC events from reaching deleteAccount at all.
				this.initializationError = cause;
			}
		});
	}

	async readFacts(
		rawRequest: unknown,
	): Promise<Result<FactsResponse, AuthorityError>> {
		const parsed = parseFactsRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 facts RPC request');
		}
		return (await this.owner()).readFacts(parsed.data);
	}

	async submit(
		rawRequest: unknown,
	): Promise<Result<SubmissionResponse, AuthorityError>> {
		const parsed = parseSubmissionRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 submission RPC request');
		}
		const result = (await this.owner()).submit(parsed.data);
		if (result.error === null) {
			for (const fact of result.data.facts) {
				if (fact.state === 'tombstone') {
					this.realtime?.closeAddress(fact.address);
				}
			}
		}
		return result;
	}

	async acceptDocument(rawRequest: unknown): Promise<DocumentAcceptance> {
		const parsed = parseDocumentPublicationRequest(
			rawRequest,
			SCALAR_SYNC_V1_LIMITS,
		);
		if (parsed === undefined) {
			throw new TypeError('invalid document V1 publication RPC request');
		}
		return (await this.owner()).acceptDocument(parsed);
	}

	override async fetch(request: Request): Promise<Response> {
		await this.ready;
		const url = new URL(request.url);
		if (
			request.method === 'GET' &&
			url.pathname === INTERNAL_DOCUMENT_REALTIME_PATH
		) {
			return this.acceptDocumentUpgrade(request);
		}
		return new Response(null, { status: 404 });
	}

	override async webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		await this.ready;
		const attachment = socket.deserializeAttachment();
		if (!isDataDocumentAttachment(attachment)) {
			socket.close(1011, 'invalid-document-attachment');
			return;
		}
		if (Date.now() >= attachment.authorizationExpiresAt) {
			this.realtime?.disconnect(this.socket(socket));
			socket.close(1000, 'credential-expired');
			return;
		}
		if (typeof message === 'string') {
			socket.close(1002, 'invalid-document-frame');
			return;
		}
		this.realtime?.receive(
			this.socket(socket),
			attachment.address,
			attachment.authorityLifetime,
			new Uint8Array(message),
		);
	}

	override webSocketClose(socket: WebSocket): void {
		this.realtime?.disconnect(this.socket(socket));
	}

	override webSocketError(socket: WebSocket): void {
		this.webSocketClose(socket);
	}

	override async alarm(): Promise<void> {
		await this.ready;
		const now = Date.now();
		let nextExpiry: number | undefined;
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			const attachment = socket.deserializeAttachment();
			if (!isDataDocumentAttachment(attachment)) continue;
			if (attachment.authorizationExpiresAt <= now) {
				this.realtime?.disconnect(this.socket(socket));
				socket.close(1000, 'credential-expired');
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

	/** Delete every scalar V1 byte owned by this principal. */
	async deleteAccount(): Promise<void> {
		await this.ready;
		await this.ctx.blockConcurrencyWhile(async () => {
			this.realtime?.closeAll();
			this.realtime = undefined;
			this.authority = undefined;
			await this.ctx.storage.deleteAll();
			// Authentication survives until the hosted deletion coordinator's last
			// step. Reopen an empty successor lifetime so a partial downstream
			// failure does not strand this actor in an unusable in-memory state.
			this.authority = this.openFreshOwner();
			this.realtime = createDocumentRealtimeV1Server({
				authority: this.authority,
			});
			this.initializationError = undefined;
		});
	}

	private async owner(): Promise<DataAuthorityV1> {
		await this.ready;
		if (this.initializationError !== undefined) {
			throw this.initializationError;
		}
		if (this.authority === undefined) {
			throw new Error('scalar V1 authority is unavailable');
		}
		return this.authority;
	}

	private openFreshOwner(): DataAuthorityV1 {
		return openScalarAuthorityV1({
			database: createDurableObjectSqliteAdapter(
				this.ctx.storage as unknown as DurableObjectSqliteStorage,
			),
			limits: SCALAR_SYNC_V1_LIMITS,
			initialize: { authorityLifetime: crypto.randomUUID() },
		});
	}

	private async acceptDocumentUpgrade(request: Request): Promise<Response> {
		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
			return new Response(null, { status: 426 });
		}
		if (
			request.headers.get('sec-websocket-protocol') !== DOCUMENT_SUBPROTOCOL
		) {
			return new Response(null, { status: 400 });
		}
		const address = {
			namespace: request.headers.get(ADDRESS_NAMESPACE_HEADER),
			collection: request.headers.get(ADDRESS_COLLECTION_HEADER),
			recordKey: request.headers.get(ADDRESS_RECORD_HEADER),
		};
		const authorityLifetime = request.headers.get(AUTHORITY_LIFETIME_HEADER);
		const authorizationExpiresAt = Number(
			request.headers.get(AUTHORIZATION_EXPIRES_HEADER),
		);
		const parsedAddress = parseAddress(address, SCALAR_SYNC_V1_LIMITS);
		const parsedLifetime = parseFactsRequest(
			{ authorityLifetime, afterSequence: 0 },
			SCALAR_SYNC_V1_LIMITS,
		);
		if (
			parsedAddress.error !== null ||
			parsedLifetime.error !== null ||
			authorityLifetime === null ||
			!Number.isSafeInteger(authorizationExpiresAt) ||
			authorizationExpiresAt <= Date.now()
		) {
			return new Response(null, { status: 400 });
		}
		await this.owner();
		if (!this.realtime?.admit(parsedAddress.data)) {
			return new Response(null, { status: 404 });
		}
		const currentAlarm = await this.ctx.storage.getAlarm();
		if (currentAlarm === null || authorizationExpiresAt < currentAlarm) {
			await this.ctx.storage.setAlarm(authorizationExpiresAt);
		}
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		const attachment: DataDocumentAttachment = {
			version: 1,
			protocol: DOCUMENT_SUBPROTOCOL,
			address: parsedAddress.data,
			authorityLifetime,
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

	private socket(socket: WebSocket): DocumentRealtimeV1Socket {
		let adapter = this.sockets.get(socket);
		if (adapter === undefined) {
			adapter = {
				send: (data) => socket.send(data),
				close: (code, reason) => socket.close(code, reason),
			};
			this.sockets.set(socket, adapter);
		}
		return adapter;
	}
}

/** Narrow RPC namespace shape consumed by the shared mount. */
export type DataAuthorityNamespace = {
	getByName(name: string): ScalarAuthorityV1Endpoint &
		DocumentAuthorityV1Endpoint & {
			fetch(request: Request): Promise<Response>;
		};
};

export type DeletableDataAuthorityNamespace = {
	getByName(name: string): { deleteAccount(): Promise<void> };
};

function stubFor(
	namespace: DataAuthorityNamespace,
	principalId: PrincipalId,
): ScalarAuthorityV1Endpoint & DocumentAuthorityV1Endpoint {
	const stub = namespace.getByName(principalName(principalId));
	return {
		readFacts: (request) => stub.readFacts(request),
		submit: (request) => stub.submit(request),
		acceptDocument: (request) => stub.acceptDocument(request),
	};
}

/** Mount the two authenticated scalar V1 routes on a Cloudflare deployment. */
export function mountCloudflareScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveDocumentPrincipal,
		resolveNamespace,
	}: {
		auth: MiddlewareHandler<E>;
		resolveDocumentPrincipal: ResolveDocumentPrincipal<E>;
		resolveNamespace(env: E['Bindings']): DataAuthorityNamespace;
	},
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: (principalId, env) =>
			stubFor(resolveNamespace(env), principalId),
	});
	mountDocumentV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		locateAuthority: (principalId, env) =>
			stubFor(resolveNamespace(env), principalId),
	});
	app.get(DOCUMENT_V1_REALTIME_PATH, async (c) => {
		const verified = await resolveDocumentRealtimeV1Upgrade(
			c,
			resolveDocumentPrincipal,
		);
		if (verified === undefined) {
			return new Response('WebSocket upgrade refused', { status: 401 });
		}
		const headers = new Headers({
			upgrade: 'websocket',
			'sec-websocket-protocol': DOCUMENT_SUBPROTOCOL,
			[ADDRESS_NAMESPACE_HEADER]: verified.address.namespace,
			[ADDRESS_COLLECTION_HEADER]: verified.address.collection,
			[ADDRESS_RECORD_HEADER]: verified.address.recordKey,
			[AUTHORITY_LIFETIME_HEADER]: verified.authorityLifetime,
			[AUTHORIZATION_EXPIRES_HEADER]: String(verified.authorizationExpiresAt),
		});
		return resolveNamespace(c.env)
			.getByName(principalName(verified.principalId))
			.fetch(
				new Request(
					`https://data-authority.internal${INTERNAL_DOCUMENT_REALTIME_PATH}`,
					{ headers },
				),
			);
	});
}

/** Bind hosted account deletion to the new principal-owned authority. */
export function createDataAuthorityAccountAuthorities(
	namespace: DeletableDataAuthorityNamespace,
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
