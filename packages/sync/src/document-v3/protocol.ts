import * as Y from '@y/y';

/**
 * The one product document bound, with two dimensions measured from the same
 * canonical encoded state. The authority enforces it exactly on the
 * post-candidate state; a replica premeasures the same bound to keep an
 * over-bound payload off the wire.
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

/**
 * The largest document payload either endpoint will admit, derived from the
 * product bound rather than pinned beside it.
 *
 * A legal peer's largest body is the full canonical state of a document within
 * `stateBytes`. The 2x factor keeps every boundary behavior of the Yjs encoding
 * (struct slicing, unconditional delete-set duplication, pending appendices)
 * out of the correctness argument entirely.
 */
export const DOCUMENT_PAYLOAD_BYTES = 2 * DOCUMENT_BOUND.stateBytes;
