import * as Y from '@y/y';

export const DOCUMENT_SUBPROTOCOL = 'epicenter-document-v1';
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';

export const DOCUMENT_BOUND = {
	stateBytes: 1_048_576,
	stateStructs: 131_072,
} as const;

export const DOCUMENT_FRAME_LIMITS = {
	encodedFrameBytes: 1 + 2 * DOCUMENT_BOUND.stateBytes,
	payloadBytes: 2 * DOCUMENT_BOUND.stateBytes,
} as const;

export type DocumentAddress = {
	namespace: string;
	table: string;
	rowId: string;
};

export type DocumentPeer = {
	nodeId: string;
	connectedAt: number;
	agentId?: string;
};

export type DocumentFrame =
	| { kind: 'sync-request'; stateVector: Uint8Array }
	| { kind: 'sync-response'; update: Uint8Array }
	| { kind: 'update'; update: Uint8Array }
	| { kind: 'presence-publish'; nodeId: string; agentId?: string }
	| { kind: 'presence'; peers: DocumentPeer[] };

const FRAME_TYPE = {
	'sync-request': 0,
	'sync-response': 1,
	update: 2,
	'presence-publish': 3,
	presence: 4,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeDocumentFrame(frame: DocumentFrame): Uint8Array {
	const payload = encodePayload(frame);
	if (
		payload.byteLength === 0 ||
		payload.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes
	) {
		throw new TypeError('Invalid document frame payload');
	}
	const encoded = new Uint8Array(1 + payload.byteLength);
	encoded[0] = FRAME_TYPE[frame.kind];
	encoded.set(payload, 1);
	return encoded;
}

export function decodeDocumentFrame(encoded: Uint8Array): DocumentFrame {
	if (
		!(encoded instanceof Uint8Array) ||
		encoded.byteLength <= 1 ||
		encoded.byteLength > DOCUMENT_FRAME_LIMITS.encodedFrameBytes
	) {
		throw new TypeError('Invalid document frame');
	}
	const payload = encoded.slice(1);
	switch (encoded[0]) {
		case FRAME_TYPE['sync-request']:
			Y.decodeStateVector(payload);
			return { kind: 'sync-request', stateVector: payload };
		case FRAME_TYPE['sync-response']:
		case FRAME_TYPE.update:
			Y.decodeUpdateV2(payload);
			return {
				kind: encoded[0] === FRAME_TYPE.update ? 'update' : 'sync-response',
				update: payload,
			};
		case FRAME_TYPE['presence-publish']:
			return parsePresencePublish(payload);
		case FRAME_TYPE.presence:
			return parsePresence(payload);
		default:
			throw new TypeError('Unknown document frame kind');
	}
}

export function measureDocumentState(encoded: Uint8Array): {
	stateBytes: number;
	stateStructs: number;
} {
	return {
		stateBytes: encoded.byteLength,
		stateStructs: Y.decodeUpdateV2(encoded).structs.length,
	};
}

export function exceedsDocumentBound(measure: {
	stateBytes: number;
	stateStructs: number;
}): boolean {
	return (
		measure.stateBytes > DOCUMENT_BOUND.stateBytes ||
		measure.stateStructs > DOCUMENT_BOUND.stateStructs
	);
}

export function documentWebSocketUrl({
	baseUrl,
	address,
}: {
	baseUrl: string | URL;
	address: DocumentAddress;
}): URL {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/sync/v1/documents/${encodeURIComponent(address.namespace)}/${encodeURIComponent(address.table)}/${encodeURIComponent(address.rowId)}`;
	url.search = '';
	url.hash = '';
	return url;
}

export function parseDocumentRoute(
	url: string | URL,
): DocumentAddress | undefined {
	const parts = new URL(url).pathname.split('/');
	if (
		parts.length !== 8 ||
		parts[1] !== 'api' ||
		parts[2] !== 'sync' ||
		parts[3] !== 'v1' ||
		parts[4] !== 'documents'
	) {
		return undefined;
	}
	try {
		const namespace = decodeURIComponent(parts[5] ?? '');
		const table = decodeURIComponent(parts[6] ?? '');
		const rowId = decodeURIComponent(parts[7] ?? '');
		return namespace.length > 0 && table.length > 0 && rowId.length > 0
			? { namespace, table, rowId }
			: undefined;
	} catch {
		return undefined;
	}
}

export function extractDocumentBearer(
	protocolHeader: string | null,
): string | undefined {
	const offered = (protocolHeader ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	const bearers = offered.filter((value) =>
		value.startsWith(BEARER_SUBPROTOCOL_PREFIX),
	);
	if (
		offered.filter((value) => value === DOCUMENT_SUBPROTOCOL).length !== 1 ||
		bearers.length !== 1
	) {
		return undefined;
	}
	const token = bearers[0]?.slice(BEARER_SUBPROTOCOL_PREFIX.length);
	return token === undefined || token.length === 0 ? undefined : token;
}

function encodePayload(frame: DocumentFrame): Uint8Array {
	switch (frame.kind) {
		case 'sync-request':
			Y.decodeStateVector(frame.stateVector);
			return frame.stateVector;
		case 'sync-response':
		case 'update':
			Y.decodeUpdateV2(frame.update);
			return frame.update;
		case 'presence-publish':
			assertIdentifier(frame.nodeId);
			if (frame.agentId !== undefined) assertIdentifier(frame.agentId);
			return textEncoder.encode(JSON.stringify(frame));
		case 'presence':
			for (const peer of frame.peers) assertPeer(peer);
			return textEncoder.encode(JSON.stringify(frame));
		default:
			return frame satisfies never;
	}
}

function parsePresencePublish(
	payload: Uint8Array,
): Extract<DocumentFrame, { kind: 'presence-publish' }> {
	const value = parseJsonRecord(payload);
	if (
		value.kind !== 'presence-publish' ||
		typeof value.nodeId !== 'string' ||
		(value.agentId !== undefined && typeof value.agentId !== 'string') ||
		Object.keys(value).some(
			(key) => key !== 'kind' && key !== 'nodeId' && key !== 'agentId',
		)
	) {
		throw new TypeError('Invalid presence publish frame');
	}
	assertIdentifier(value.nodeId);
	if (value.agentId !== undefined) assertIdentifier(value.agentId);
	return {
		kind: 'presence-publish',
		nodeId: value.nodeId,
		...(value.agentId === undefined ? {} : { agentId: value.agentId }),
	};
}

function parsePresence(
	payload: Uint8Array,
): Extract<DocumentFrame, { kind: 'presence' }> {
	const value = parseJsonRecord(payload);
	if (
		value.kind !== 'presence' ||
		!Array.isArray(value.peers) ||
		Object.keys(value).some((key) => key !== 'kind' && key !== 'peers')
	) {
		throw new TypeError('Invalid presence frame');
	}
	for (const peer of value.peers) assertPeer(peer);
	return { kind: 'presence', peers: value.peers as DocumentPeer[] };
}

function parseJsonRecord(payload: Uint8Array): Record<string, unknown> {
	const value = JSON.parse(textDecoder.decode(payload)) as unknown;
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError('Invalid presence frame');
	}
	return value as Record<string, unknown>;
}

function assertPeer(value: unknown): asserts value is DocumentPeer {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new TypeError('Invalid presence peer');
	}
	const peer = value as Record<string, unknown>;
	if (
		typeof peer.nodeId !== 'string' ||
		typeof peer.connectedAt !== 'number' ||
		!Number.isFinite(peer.connectedAt) ||
		(peer.agentId !== undefined && typeof peer.agentId !== 'string') ||
		Object.keys(peer).some(
			(key) => key !== 'nodeId' && key !== 'connectedAt' && key !== 'agentId',
		)
	) {
		throw new TypeError('Invalid presence peer');
	}
	assertIdentifier(peer.nodeId);
	if (peer.agentId !== undefined) assertIdentifier(peer.agentId);
}

function assertIdentifier(value: string): void {
	if (value.length === 0 || textEncoder.encode(value).byteLength > 256) {
		throw new TypeError('Invalid presence identifier');
	}
}
