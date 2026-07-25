/**
 * Document Bound Tests
 *
 * Verifies the one shared measurement both endpoints use to decide whether a
 * document may be admitted.
 *
 * Key behaviors:
 * - both dimensions measure from one canonical encoded state
 * - the measure is stable across re-encode and hydration round trips
 * - the admitted payload size is derived from the bound, not pinned beside it
 */
import { describe, expect, test } from 'bun:test';
import * as Y from '@y/y';
import {
	DOCUMENT_BOUND,
	DOCUMENT_PAYLOAD_BYTES,
	exceedsDocumentBound,
	measureDocument,
	measureDocumentState,
} from './protocol.js';

describe('document bound', () => {
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

	test('the admitted payload size derives from the bound with room to spare', () => {
		// A legal peer's largest body is one maximal canonical state; the factor
		// keeps Yjs encoding boundary behavior out of the correctness argument.
		expect(DOCUMENT_PAYLOAD_BYTES).toBe(2 * DOCUMENT_BOUND.stateBytes);
		expect(DOCUMENT_PAYLOAD_BYTES).toBeGreaterThan(DOCUMENT_BOUND.stateBytes);
	});
});

function createDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	doc.get('content').insert(0, content);
	return doc;
}
