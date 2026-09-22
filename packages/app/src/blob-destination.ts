import type { BlobStore } from '@epicenter/blobs';
import type { RecordingFactory } from './recorder.js';

/** Provenance and admitted publication are private to genuine LocalBlobs handles. */
export type BlobDestination = {
	id: string;
	native: boolean;
	store: BlobStore;
	recording: RecordingFactory;
	assertOpen(): void;
	recorders: Set<{ close(): Promise<void> }>;
	transfers: Set<Promise<unknown>>;
};
export const blobDestinations = new WeakMap<object, BlobDestination>();
export function blobDestination(handle: object) {
	const destination = blobDestinations.get(handle);
	if (!destination)
		throw new TypeError('Expected an opened LocalBlobs handle.');
	destination.assertOpen();
	return destination;
}
