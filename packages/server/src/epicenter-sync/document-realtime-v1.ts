import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
	encodeDocumentAcceptance,
	parseDocumentPublicationRequest,
} from '@epicenter/data/document-v1';
import {
	addressesEqual,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	type DocumentFrame,
	decodeDocumentFrame,
	encodeDocumentFrame,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

import type { DataAuthorityV1 } from './authority-v1.js';

const hydrationOrigin = Symbol('epicenter-document-realtime-v1-hydration');

export type DocumentRealtimeV1Socket = {
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
};

type Session = {
	socket: DocumentRealtimeV1Socket;
	address: RecordAddress;
	authorityLifetime: string;
};

function encodeAuthorityDiff(
	authority: DataAuthorityV1,
	address: RecordAddress,
	stateVector: Uint8Array,
): { update: Uint8Array; stateVector: Uint8Array } | undefined {
	Y.decodeStateVector(stateVector);
	const stored = authority.readDocument(address);
	if (stored.state !== 'live') return undefined;
	const document = new Y.Doc({ gc: true });
	try {
		if (stored.update !== undefined) {
			Y.applyUpdateV2(document, stored.update, hydrationOrigin);
		}
		return {
			update: new Uint8Array(Y.encodeStateAsUpdateV2(document, stateVector)),
			stateVector: new Uint8Array(Y.encodeStateVector(document)),
		};
	} finally {
		document.destroy();
	}
}

/** Presence-free realtime overlay over the authority's one acceptance function. */
export function createDocumentRealtimeV1Server({
	authority,
}: {
	authority: DataAuthorityV1;
}) {
	const sessions = new Map<DocumentRealtimeV1Socket, Session>();

	function sessionsAt(address: RecordAddress): Session[] {
		return [...sessions.values()].filter((session) =>
			addressesEqual(session.address, address),
		);
	}

	function disconnect(socket: DocumentRealtimeV1Socket): void {
		sessions.delete(socket);
	}

	function close(
		socket: DocumentRealtimeV1Socket,
		code: number,
		reason: string,
	) {
		disconnect(socket);
		try {
			socket.close(code, reason);
		} catch {
			// The transport is already closed.
		}
	}

	function trySend(
		socket: DocumentRealtimeV1Socket,
		frame: DocumentFrame,
	): boolean {
		try {
			socket.send(encodeDocumentFrame(frame));
			return true;
		} catch {
			close(socket, 1011, 'send-failed');
			return false;
		}
	}

	function synchronize(
		socket: DocumentRealtimeV1Socket,
		address: RecordAddress,
		stateVector: Uint8Array,
	): boolean {
		const diff = encodeAuthorityDiff(authority, address, stateVector);
		if (diff === undefined) {
			close(socket, 1000, 'record-not-live');
			return false;
		}
		return (
			trySend(socket, {
				kind: 'sync-request',
				stateVector: diff.stateVector,
			}) && trySend(socket, { kind: 'sync-response', update: diff.update })
		);
	}

	function acceptUpdate(session: Session, update: Uint8Array): void {
		const stored = authority.readDocument(session.address);
		if (stored.state !== 'live') {
			close(session.socket, 1000, 'record-not-live');
			return;
		}
		const document = new Y.Doc({ gc: true });
		let payload: Uint8Array;
		try {
			if (stored.update !== undefined) {
				Y.applyUpdateV2(document, stored.update, hydrationOrigin);
			}
			Y.applyUpdateV2(document, update, hydrationOrigin);
			if (
				document.store.pendingStructs !== null ||
				document.store.pendingDs !== null
			) {
				throw new TypeError('document update has unresolved dependencies');
			}
			payload = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		} finally {
			document.destroy();
		}
		const request = parseDocumentPublicationRequest(
			{
				authorityLifetime: session.authorityLifetime,
				address: session.address,
				protocolVersion: DOCUMENT_PUBLICATION_VERSION,
				payload,
				digest: documentPayloadDigest(payload),
			},
			SCALAR_SYNC_V1_LIMITS,
		);
		if (request === undefined) {
			throw new TypeError('invalid document publication update');
		}
		const result = authority.acceptDocument(request);
		if (
			!trySend(session.socket, {
				kind: 'publication-response',
				acceptance: encodeDocumentAcceptance(result),
			})
		) {
			return;
		}
		switch (result.kind) {
			case 'accepted':
				for (const peer of sessionsAt(session.address)) {
					if (peer.socket !== session.socket) {
						trySend(peer.socket, { kind: 'update', update });
					}
				}
				return;
			case 'document-bound':
				close(session.socket, DOCUMENT_BACKSTOP_CLOSE_CODE, 'document-bound');
				return;
			case 'record-not-live':
				for (const peer of sessionsAt(session.address)) {
					close(peer.socket, 1000, 'record-not-live');
				}
				return;
			case 'lifetime-mismatch':
				close(session.socket, 1000, 'lifetime-mismatch');
				return;
		}
	}

	return {
		admit(address: RecordAddress): boolean {
			return authority.readDocument(address).state === 'live';
		},
		restore(
			socket: DocumentRealtimeV1Socket,
			address: RecordAddress,
			authorityLifetime: string,
		): void {
			if (authority.readDocument(address).state !== 'live') {
				close(socket, 1000, 'record-not-live');
				return;
			}
			sessions.set(socket, {
				socket,
				address: structuredClone(address),
				authorityLifetime,
			});
		},
		receive(
			socket: DocumentRealtimeV1Socket,
			address: RecordAddress,
			authorityLifetime: string,
			encoded: Uint8Array,
		): void {
			try {
				const frame = decodeDocumentFrame(encoded);
				const existing = sessions.get(socket);
				if (existing === undefined) {
					if (frame.kind !== 'sync-request') {
						throw new TypeError('expected initial document sync request');
					}
					sessions.set(socket, {
						socket,
						address: structuredClone(address),
						authorityLifetime,
					});
					if (!synchronize(socket, address, frame.stateVector)) {
						disconnect(socket);
					}
					return;
				}
				if (
					!addressesEqual(existing.address, address) ||
					existing.authorityLifetime !== authorityLifetime
				) {
					throw new TypeError('document socket identity changed');
				}
				switch (frame.kind) {
					case 'sync-request':
						synchronize(socket, address, frame.stateVector);
						return;
					case 'sync-response':
					case 'update':
						acceptUpdate(existing, frame.update);
						return;
					case 'publication-response':
						throw new TypeError('unexpected document publication response');
				}
			} catch {
				close(socket, 1002, 'invalid-document-frame');
			}
		},
		disconnect,
		closeAddress(address: RecordAddress): void {
			for (const session of sessionsAt(address)) {
				close(session.socket, 1000, 'record-not-live');
			}
		},
		closeAll(): void {
			for (const session of [...sessions.values()]) {
				close(session.socket, 1001, 'server-shutdown');
			}
		},
		get connectionCount(): number {
			return sessions.size;
		},
	};
}

export type DocumentRealtimeV1Server = ReturnType<
	typeof createDocumentRealtimeV1Server
>;
