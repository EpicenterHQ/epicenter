import * as Y from '@y/y';

export const DOCUMENT_SUBPROTOCOL = 'epicenter-document-v3';

/**
 * Defensive transport backstop for a refused update (WebSocket 1009).
 *
 * It names no product state: a client whose estimate was stale reconnects,
 * applies downstream, measures exactly, and suppresses. Product fullness
 * derives from measurement, never from this close code.
 */
export const DOCUMENT_BACKSTOP_CLOSE_CODE = 1009;

/**
 * The one product document bound, with two dimensions measured from the same
 * canonical encoded state. The authority enforces it exactly on the
 * post-candidate state; clients estimate it to suppress sending before a
 * refusal.
 *
 * `stateBytes` bounds storage and transfer. `stateStructs` bounds authority
 * memory and CPU during hydration; it is pinned from measured isolate budgets
 * (workerd: ~0.06 KiB and ~0.7 microseconds per struct during apply), not from
 * a legitimacy judgment. Nearly all measured real content crosses the byte
 * bound first (under ~50 structs/KiB); extremely format-dense text such as
 * per-character marks (~154 structs/KiB) can hit the structural wall below the
 * byte bound, so a structural refusal is a resource fact, never proof of
 * abuse.
 */
export const DOCUMENT_BOUND = {
	stateBytes: 1_048_576,
	stateStructs: 131_072,
} as const;

export type DocumentMeasure = {
	stateBytes: number;
	stateStructs: number;
};

/** Measure one canonical encoded state in both bound dimensions. */
export function measureDocumentState(encoded: Uint8Array): DocumentMeasure {
	return {
		stateBytes: encoded.byteLength,
		stateStructs: Y.decodeUpdateV2(encoded).structs.length,
	};
}

/** Measure one live document's canonical state in both bound dimensions. */
export function measureDocument(doc: Y.Doc): DocumentMeasure {
	return measureDocumentState(Y.encodeStateAsUpdateV2(doc));
}

/** True when either dimension exceeds the document bound. */
export function exceedsDocumentBound(measure: DocumentMeasure): boolean {
	return (
		measure.stateBytes > DOCUMENT_BOUND.stateBytes ||
		measure.stateStructs > DOCUMENT_BOUND.stateStructs
	);
}

const HEADER_BYTES = 1;

/**
 * The transport envelope, derived from the product bound rather than pinned
 * beside it: a legal peer's largest frame is a diff or full state of a
 * document within `stateBytes`, and measured diffs never exceeded canonical
 * state across sliced, delete-set-heavy, and pending shapes. The 2x factor
 * keeps every boundary behavior of the Yjs encoding (struct slicing,
 * unconditional delete-set duplication, pending appendices) out of the
 * correctness argument entirely.
 */
export const DOCUMENT_FRAME_LIMITS = {
	headerBytes: HEADER_BYTES,
	encodedFrameBytes: HEADER_BYTES + 2 * DOCUMENT_BOUND.stateBytes,
	payloadBytes: 2 * DOCUMENT_BOUND.stateBytes,
} as const;

/** One data message on a WebSocket already scoped to one row document. */
export type DocumentFrame =
	| { kind: 'sync-request'; stateVector: Uint8Array }
	| { kind: 'sync-response'; update: Uint8Array }
	| { kind: 'update'; update: Uint8Array }
	| { kind: 'publication-response'; acceptance: Uint8Array };

const FRAME_TYPE = {
	'sync-request': 0,
	'sync-response': 1,
	update: 2,
	'publication-response': 3,
} as const;

/**
 * Encode one document-local WebSocket message.
 *
 * The selected WebSocket subprotocol owns the protocol major and WebSocket
 * preserves message boundaries, so the envelope is only `[kind:u8][payload]`.
 */
export function encodeDocumentFrame(
	frame: DocumentFrame,
): Uint8Array<ArrayBuffer> {
	assertFrame(frame);
	const payload =
		frame.kind === 'sync-request'
			? frame.stateVector
			: frame.kind === 'publication-response'
				? frame.acceptance
				: frame.update;
	const encoded = new Uint8Array(HEADER_BYTES + payload.byteLength);
	encoded[0] = FRAME_TYPE[frame.kind];
	encoded.set(payload, HEADER_BYTES);
	return encoded;
}

/** Decode and validate one complete document-local WebSocket message. */
export function decodeDocumentFrame(encoded: Uint8Array): DocumentFrame {
	if (
		!(encoded instanceof Uint8Array) ||
		encoded.byteLength <= HEADER_BYTES ||
		encoded.byteLength > DOCUMENT_FRAME_LIMITS.encodedFrameBytes
	) {
		throw new TypeError('Invalid document frame');
	}

	const payload = encoded.slice(HEADER_BYTES);
	switch (encoded[0]) {
		case FRAME_TYPE['sync-request']:
			return { kind: 'sync-request', stateVector: payload };
		case FRAME_TYPE['sync-response']:
			return { kind: 'sync-response', update: payload };
		case FRAME_TYPE.update:
			return { kind: 'update', update: payload };
		case FRAME_TYPE['publication-response']:
			return { kind: 'publication-response', acceptance: payload };
		default:
			throw new TypeError('Unknown document frame kind');
	}
}

function assertFrame(frame: DocumentFrame): void {
	if (!isRecord(frame) || typeof frame.kind !== 'string') {
		throw new TypeError('Invalid document frame');
	}
	switch (frame.kind) {
		case 'sync-request':
			assertExactKeys(frame, ['kind', 'stateVector']);
			assertPayload(frame.stateVector);
			return;
		case 'sync-response':
		case 'update':
			assertExactKeys(frame, ['kind', 'update']);
			assertPayload(frame.update);
			return;
		case 'publication-response':
			assertExactKeys(frame, ['kind', 'acceptance']);
			assertPayload(frame.acceptance);
			return;
		default:
			throw new TypeError('Unknown document frame kind');
	}
}

function assertPayload(value: unknown): asserts value is Uint8Array {
	if (
		!(value instanceof Uint8Array) ||
		value.byteLength === 0 ||
		value.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes
	) {
		throw new TypeError('Invalid document frame payload');
	}
}

function assertExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): void {
	const keys = Object.keys(value);
	if (
		keys.length !== expected.length ||
		expected.some((key) => !Object.hasOwn(value, key))
	) {
		throw new TypeError('Document frame has unexpected fields');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
