/**
 * Route-bound Document Protocol Tests
 *
 * Verifies the Yjs 14 state-vector and update wire after connection lifecycle
 * moved to WebSocket admission and close codes.
 *
 * Key behaviors:
 * - the selected subprotocol is the only protocol-major fact
 * - WebSocket boundaries need only a one-byte frame kind
 * - publication responses carry opaque data-owned acceptance bytes
 * - addresses, multiplexing, presence, and lifecycle controls are absent
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_BOUND,
	DOCUMENT_FRAME_LIMITS,
	DOCUMENT_SUBPROTOCOL,
	type DocumentFrame,
	decodeDocumentFrame,
	encodeDocumentFrame,
	exceedsDocumentBound,
	measureDocument,
	measureDocumentState,
} from './protocol.js';

describe('document v3 frame codec', () => {
	test('round trips the complete fixed-document data protocol', () => {
		const doc = createDoc('hello');
		const frames: DocumentFrame[] = [
			{ kind: 'sync-request', stateVector: Y.encodeStateVector(doc) },
			{ kind: 'sync-response', update: Y.encodeStateAsUpdateV2(doc) },
			{ kind: 'update', update: Y.encodeStateAsUpdateV2(doc) },
			{
				kind: 'publication-response',
				acceptance: new TextEncoder().encode('{"kind":"accepted"}'),
			},
		];
		for (const frame of frames) {
			expect(decodeDocumentFrame(encodeDocumentFrame(frame))).toEqual(frame);
		}
	});

	test('keeps authority acceptance opaque to the transport package', () => {
		const acceptance = new TextEncoder().encode(
			'{"kind":"accepted","receipt":{"digest":"abc"}}',
		);
		const frame = decodeDocumentFrame(
			encodeDocumentFrame({ kind: 'publication-response', acceptance }),
		);
		expect(frame).toEqual({ kind: 'publication-response', acceptance });
	});

	test('carries a real Yjs 14 state-vector handshake and incremental update', () => {
		const server = createDoc('server');
		const client = new Y.Doc();
		const request = decodeDocumentFrame(
			encodeDocumentFrame({
				kind: 'sync-request',
				stateVector: Y.encodeStateVector(client),
			}),
		);
		if (request.kind !== 'sync-request')
			throw new Error('Expected sync request');
		const response = decodeDocumentFrame(
			encodeDocumentFrame({
				kind: 'sync-response',
				update: Y.encodeStateAsUpdateV2(server, request.stateVector),
			}),
		);
		if (response.kind !== 'sync-response') {
			throw new Error('Expected sync response');
		}
		Y.applyUpdateV2(client, response.update);
		expect(client.get('content').toString()).toBe('server');

		let incremental: Uint8Array | undefined;
		server.on('updateV2', (update: Uint8Array) => {
			incremental = update;
		});
		server.get('content').insert(6, ' update');
		if (!incremental) throw new Error('Expected an incremental update');
		const update = decodeDocumentFrame(
			encodeDocumentFrame({ kind: 'update', update: incremental }),
		);
		if (update.kind !== 'update') throw new Error('Expected update');
		Y.applyUpdateV2(client, update.update);
		expect(client.get('content').toString()).toBe('server update');
	});

	test('uses one frame-kind byte because the subprotocol owns the major', () => {
		const encoded = encodeDocumentFrame({
			kind: 'update',
			update: new Uint8Array([7, 8, 9]),
		});
		expect(DOCUMENT_SUBPROTOCOL).toBe('epicenter-document-v3');
		expect(DOCUMENT_FRAME_LIMITS.headerBytes).toBe(1);
		expect([...encoded]).toEqual([2, 7, 8, 9]);
	});

	test('reserves no product close code; 1009 is only the backstop number', () => {
		expect(DOCUMENT_BACKSTOP_CLOSE_CODE).toBe(1009);
	});

	test('the frame envelope admits a maximal legal canonical state', () => {
		const maximalState = new Uint8Array(DOCUMENT_BOUND.stateBytes);
		const frame = encodeDocumentFrame({
			kind: 'sync-response',
			update: maximalState,
		});
		expect(frame.byteLength).toBeLessThanOrEqual(
			DOCUMENT_FRAME_LIMITS.encodedFrameBytes,
		);
		expect(DOCUMENT_FRAME_LIMITS.payloadBytes).toBe(
			2 * DOCUMENT_BOUND.stateBytes,
		);
	});

	test('both bound dimensions measure from one canonical encoded state', () => {
		const doc = createDoc('measured');
		const encoded = Y.encodeStateAsUpdateV2(doc);
		const fromState = measureDocumentState(encoded);
		const fromDoc = measureDocument(doc);
		expect(fromDoc).toEqual(fromState);
		expect(fromState.stateBytes).toBe(encoded.byteLength);
		expect(fromState.stateStructs).toBe(
			Y.decodeUpdateV2(encoded).structs.length,
		);
		expect(exceedsDocumentBound(fromState)).toBe(false);
		expect(
			exceedsDocumentBound({
				stateBytes: DOCUMENT_BOUND.stateBytes + 1,
				stateStructs: 1,
			}),
		).toBe(true);
		expect(
			exceedsDocumentBound({
				stateBytes: 1,
				stateStructs: DOCUMENT_BOUND.stateStructs + 1,
			}),
		).toBe(true);
	});

	test('the measure is stable across re-encode and hydration round trips', () => {
		const doc = createDoc('stable');
		doc.get('content').delete(0, 3);
		const first = measureDocument(doc);
		expect(measureDocument(doc)).toEqual(first);
		const rehydrated = new Y.Doc();
		Y.applyUpdateV2(rehydrated, Y.encodeStateAsUpdateV2(doc));
		expect(measureDocument(rehydrated)).toEqual(first);
	});

	test('rejects malformed, empty, over-limit, and unknown frames', () => {
		expect(() => decodeDocumentFrame(new Uint8Array())).toThrow(
			'Invalid document frame',
		);
		expect(() => decodeDocumentFrame(new Uint8Array([0]))).toThrow(
			'Invalid document frame',
		);
		expect(() =>
			decodeDocumentFrame(
				new Uint8Array(DOCUMENT_FRAME_LIMITS.encodedFrameBytes + 1),
			),
		).toThrow('Invalid document frame');
		expect(() => decodeDocumentFrame(new Uint8Array([99, 1]))).toThrow(
			'Unknown document frame kind',
		);
		expect(() =>
			encodeDocumentFrame({ kind: 'update', update: new Uint8Array() }),
		).toThrow('Invalid document frame payload');
		expect(() =>
			encodeDocumentFrame({
				kind: 'update',
				update: new Uint8Array(DOCUMENT_FRAME_LIMITS.payloadBytes + 1),
			}),
		).toThrow('Invalid document frame payload');
	});

	test('has no address, multiplex, presence, or lifecycle frame', () => {
		for (const frame of [
			{ kind: 'subscribe', table: 'notes', rowId: 'one' },
			{ kind: 'unsubscribe', table: 'notes', rowId: 'one' },
			{ kind: 'presence', payload: new Uint8Array([1]) },
			{ kind: 'unknown' },
			{ kind: 'revoked' },
			{ kind: 'too-large' },
			{
				kind: 'update',
				table: 'notes',
				rowId: 'one',
				update: new Uint8Array([1]),
			},
		]) {
			expect(() => encodeDocumentFrame(frame as never)).toThrow();
		}
	});
});

function createDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.get('content').insert(0, content);
	return doc;
}
