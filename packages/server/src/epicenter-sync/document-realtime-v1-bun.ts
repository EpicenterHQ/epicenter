import {
	parseAddress,
	parseFactsRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import { DOCUMENT_SUBPROTOCOL } from '@epicenter/sync/document-v3';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';

import { sanitizeUpgradeSubprotocols } from '../sanitize-upgrade-subprotocols.js';
import type { DataAuthorityV1 } from './authority-v1.js';
import {
	createDocumentRealtimeV1Server,
	type DocumentRealtimeV1Server,
	type DocumentRealtimeV1Socket,
} from './document-realtime-v1.js';

export type BunDataDocumentV1SocketData = {
	surface: 'epicenter-data-document';
	principalId: PrincipalId;
	address: RecordAddress;
	authorityLifetime: string;
	authorizationExpiresAt: number;
};

/** Bind the document V1 realtime overlay to Bun's one WebSocket server. */
export function createBunDocumentRealtimeV1Binding({
	locateAuthority,
}: {
	locateAuthority(principalId: PrincipalId): DataAuthorityV1;
}) {
	const servers = new Map<PrincipalId, DocumentRealtimeV1Server>();
	const adapters = new WeakMap<
		ServerWebSocket<BunDataDocumentV1SocketData>,
		DocumentRealtimeV1Socket
	>();
	const activeSockets = new Set<ServerWebSocket<BunDataDocumentV1SocketData>>();
	const expiryTimers = new Map<
		ServerWebSocket<BunDataDocumentV1SocketData>,
		ReturnType<typeof setTimeout>
	>();

	function documentServer(principalId: PrincipalId): DocumentRealtimeV1Server {
		let server = servers.get(principalId);
		if (server === undefined) {
			server = createDocumentRealtimeV1Server({
				authority: locateAuthority(principalId),
			});
			servers.set(principalId, server);
		}
		return server;
	}

	function socketAdapter(
		socket: ServerWebSocket<BunDataDocumentV1SocketData>,
	): DocumentRealtimeV1Socket {
		let adapter = adapters.get(socket);
		if (adapter === undefined) {
			adapter = {
				send: (data) => socket.send(data),
				close: (code, reason) => socket.close(code, reason),
			};
			adapters.set(socket, adapter);
		}
		return adapter;
	}

	const websocket: WebSocketHandler<BunDataDocumentV1SocketData> = {
		open(socket) {
			activeSockets.add(socket);
			expiryTimers.set(
				socket,
				setTimeout(
					() => socket.close(1000, 'credential-expired'),
					Math.max(0, socket.data.authorizationExpiresAt - Date.now()),
				),
			);
		},
		message(socket, message) {
			if (Date.now() >= socket.data.authorizationExpiresAt) {
				socket.close(1000, 'credential-expired');
				return;
			}
			if (typeof message === 'string') {
				socket.close(1002, 'invalid-document-frame');
				return;
			}
			documentServer(socket.data.principalId).receive(
				socketAdapter(socket),
				socket.data.address,
				socket.data.authorityLifetime,
				new Uint8Array(message),
			);
		},
		close(socket) {
			activeSockets.delete(socket);
			clearTimeout(expiryTimers.get(socket));
			expiryTimers.delete(socket);
			documentServer(socket.data.principalId).disconnect(socketAdapter(socket));
		},
	};

	return {
		websocket,
		handleAuthorizedUpgrade(
			request: Request,
			server: Server<BunDataDocumentV1SocketData>,
			verified: {
				principalId: PrincipalId;
				address: RecordAddress;
				authorityLifetime: string;
				authorizationExpiresAt: number;
			},
		): Response {
			const lifetime = parseFactsRequest(
				{
					authorityLifetime: verified.authorityLifetime,
					afterSequence: 0,
				},
				SCALAR_SYNC_V1_LIMITS,
			);
			const address = parseAddress(verified.address, SCALAR_SYNC_V1_LIMITS);
			if (
				lifetime.error !== null ||
				address.error !== null ||
				!documentServer(verified.principalId).admit(address.data)
			) {
				return new Response('WebSocket upgrade refused', { status: 404 });
			}
			sanitizeUpgradeSubprotocols(request, DOCUMENT_SUBPROTOCOL);
			const upgraded = server.upgrade(request, {
				data: {
					...verified,
					address: address.data,
					surface: 'epicenter-data-document',
				},
			});
			return upgraded
				? new Response(null)
				: new Response('Expected WebSocket upgrade', { status: 426 });
		},
		closeAddress(principalId: PrincipalId, address: RecordAddress): void {
			servers.get(principalId)?.closeAddress(address);
		},
		closeAll(): void {
			for (const server of servers.values()) server.closeAll();
			for (const socket of activeSockets) {
				socket.close(1001, 'server-shutdown');
			}
			activeSockets.clear();
			for (const timer of expiryTimers.values()) clearTimeout(timer);
			expiryTimers.clear();
		},
	};
}

export type BunDocumentRealtimeV1Binding = ReturnType<
	typeof createBunDocumentRealtimeV1Binding
>;
