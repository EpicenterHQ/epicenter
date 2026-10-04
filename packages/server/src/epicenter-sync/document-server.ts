import {
	parseMemberKey,
	parseNamespaceKey,
	parseRowId,
} from '@epicenter/data/protocol';
import {
	type DocumentAddress,
	type DocumentFrame,
	type DocumentPeer,
	decodeDocumentFrame,
	encodeDocumentFrame,
	extractDocumentBearer,
	parseDocumentRoute,
} from '@epicenter/document-sync';
import type { SqliteDatabase } from '@epicenter/sqlite';
import * as Y from '@y/y';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import { createEpicenterDocumentStore } from './document-store.js';

const hydrationOrigin = Symbol('epicenter-document-server-hydration');

export type EpicenterDocumentSocket = {
	send(data: Uint8Array): void;
	close(): void;
};

type Session = {
	socket: EpicenterDocumentSocket;
	address: DocumentAddress;
	presence: DocumentPeer | undefined;
};

export const DocumentUpgradeError = defineErrors({
	InvalidRoute: () => ({ message: 'Invalid document route' }),
	InvalidSubprotocol: () => ({ message: 'Invalid document subprotocol offer' }),
	Unauthorized: () => ({ message: 'Document bearer was refused' }),
	RowNotLive: () => ({ message: 'Document row is not live' }),
});
export type DocumentUpgradeError = InferErrors<typeof DocumentUpgradeError>;

export async function verifyDocumentUpgrade({
	request,
	resolveBearer,
}: {
	request: Request;
	resolveBearer(
		token: string,
	): string | undefined | Promise<string | undefined>;
}): Promise<
	Result<
		{ principalId: string; address: DocumentAddress },
		DocumentUpgradeError
	>
> {
	const address = parseDocumentRoute(request.url);
	if (
		address === undefined ||
		parseNamespaceKey(address.namespace).error !== null ||
		parseMemberKey(address.table).error !== null ||
		parseRowId(address.rowId).error !== null
	) {
		return DocumentUpgradeError.InvalidRoute();
	}
	if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
		return DocumentUpgradeError.InvalidSubprotocol();
	}
	const bearer = extractDocumentBearer(
		request.headers.get('sec-websocket-protocol'),
	);
	if (bearer === undefined) return DocumentUpgradeError.InvalidSubprotocol();
	const principalId = await resolveBearer(bearer);
	if (principalId === undefined) return DocumentUpgradeError.Unauthorized();
	return Ok({ principalId, address });
}

/** Create the runtime-agnostic document handler over one principal store. */
export function createEpicenterDocumentServer({
	database,
	clock = Date.now,
}: {
	database: SqliteDatabase;
	clock?: () => number;
}) {
	const store = createEpicenterDocumentStore(database);
	const sessions = new Map<EpicenterDocumentSocket, Session>();

	function sameAddress(left: DocumentAddress, right: DocumentAddress): boolean {
		return (
			left.namespace === right.namespace &&
			left.table === right.table &&
			left.rowId === right.rowId
		);
	}

	function sessionsAt(address: DocumentAddress): Session[] {
		return [...sessions.values()].filter((session) =>
			sameAddress(session.address, address),
		);
	}

	function trySend(
		socket: EpicenterDocumentSocket,
		frame: DocumentFrame,
	): boolean {
		try {
			socket.send(encodeDocumentFrame(frame));
			return true;
		} catch {
			disconnect(socket);
			return false;
		}
	}

	function close(socket: EpicenterDocumentSocket): void {
		disconnect(socket);
		try {
			socket.close();
		} catch {
			// The transport is already closed.
		}
	}

	function broadcastPresence(address: DocumentAddress): void {
		const peers = sessionsAt(address);
		for (const recipient of peers) {
			trySend(recipient.socket, {
				kind: 'presence',
				peers: peers
					.filter((peer) => peer !== recipient)
					.flatMap((peer) =>
						peer.presence === undefined ? [] : [peer.presence],
					),
			});
		}
	}

	function disconnect(socket: EpicenterDocumentSocket): void {
		const session = sessions.get(socket);
		if (session === undefined) return;
		sessions.delete(socket);
		broadcastPresence(session.address);
	}

	function closeRow(address: DocumentAddress): void {
		for (const session of sessionsAt(address)) close(session.socket);
	}

	function connect(
		socket: EpicenterDocumentSocket,
		address: DocumentAddress,
		stateVector: Uint8Array,
	): void {
		Y.decodeStateVector(stateVector);
		const updates = store.openIfLive(address);
		if (updates === undefined) {
			close(socket);
			return;
		}
		const document = new Y.Doc({ gc: true });
		try {
			for (const update of updates) {
				Y.applyUpdateV2(document, update, hydrationOrigin);
			}
			sessions.set(socket, {
				socket,
				address: { ...address },
				presence: undefined,
			});
			if (
				!trySend(socket, {
					kind: 'sync-request',
					stateVector: Y.encodeStateVector(document),
				}) ||
				!trySend(socket, {
					kind: 'sync-response',
					update: Y.encodeStateAsUpdateV2(document, stateVector),
				})
			) {
				close(socket);
				return;
			}
			broadcastPresence(address);
		} finally {
			document.destroy();
		}
	}

	return {
		/** Upgrade-time scalar-liveness gate. */
		admit(address: DocumentAddress): boolean {
			return store.openIfLive(address) !== undefined;
		},
		receive(
			socket: EpicenterDocumentSocket,
			address: DocumentAddress,
			encoded: Uint8Array,
		): void {
			try {
				const frame = decodeDocumentFrame(encoded);
				const session = sessions.get(socket);
				if (session === undefined) {
					if (frame.kind !== 'sync-request')
						throw new TypeError('Expected sync request');
					connect(socket, address, frame.stateVector);
					return;
				}
				if (!sameAddress(session.address, address))
					throw new TypeError('Socket address changed');
				switch (frame.kind) {
					case 'sync-response':
					case 'update': {
						const result = store.appendIfLive(address, frame.update);
						if (result === 'not-live') {
							closeRow(address);
							return;
						}
						if (result !== 'appended') {
							close(socket);
							return;
						}
						for (const peer of sessionsAt(address)) {
							if (peer.socket !== socket) {
								trySend(peer.socket, { kind: 'update', update: frame.update });
							}
						}
						return;
					}
					case 'presence-publish':
						session.presence = {
							nodeId: frame.nodeId,
							connectedAt: clock(),
							...(frame.agentId === undefined
								? {}
								: { agentId: frame.agentId }),
						};
						broadcastPresence(address);
						return;
					case 'sync-request':
					case 'presence':
						throw new TypeError('Unexpected document frame');
				}
			} catch {
				close(socket);
			}
		},
		disconnect,
		/** Close every socket after scalar deletion commits. */
		closeRow,
		get connectionCount(): number {
			return sessions.size;
		},
	};
}

export type EpicenterDocumentServer = ReturnType<
	typeof createEpicenterDocumentServer
>;
