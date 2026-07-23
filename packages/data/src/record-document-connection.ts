import type { RecordAddress } from './protocol/v1/index.js';
import type { RowDocument } from './row-document.js';

type UpdateListener = (update: Uint8Array, origin: unknown) => void;

export type RecordDocumentConnectionTarget = {
	address: RecordAddress;
	applyUpdate(update: Uint8Array, origin?: unknown): void;
	encodeStateVector(): Uint8Array;
	encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
	observe(listener: UpdateListener): () => void;
	subscribeRevocation(listener: (error: Error) => void): () => void;
};

const targets = new WeakMap<RowDocument, RecordDocumentConnectionTarget>();

/** Register the private realtime target carried by one record document handle. */
export function registerRecordDocumentConnectionTarget(
	document: RowDocument,
	target: RecordDocumentConnectionTarget,
): void {
	targets.set(document, target);
}

/** Recover the realtime target without exposing its mutable Y.Doc. */
export function recordDocumentConnectionTarget(
	document: RowDocument,
): RecordDocumentConnectionTarget {
	const target = targets.get(document);
	if (target === undefined) {
		throw new Error('Row document is not backed by a record document runtime');
	}
	return target;
}
