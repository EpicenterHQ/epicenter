/** Local blobs are borrowed from their store and require genuine sources. */
import type { BlobId } from '@epicenter/blobs';
import type { LocalBlobs } from './blobs.js';
import { createRecorder } from './recorder.js';

export function blobContracts(local: LocalBlobs, id: BlobId) {
	createRecorder({ localBlobs: local });
	local.copyFrom(local, id);
	// @ts-expect-error The store owns close.
	local.close();
	// @ts-expect-error The store owns admission.
	local.signal;
	// @ts-expect-error Blob capabilities do not own capture.
	local.recorder;
	// @ts-expect-error Raw arbitrary-ID publication is private.
	local.put(id, new Blob());
	// @ts-expect-error Structural fake sources have no provenance.
	local.copyFrom({ get: local.get }, id);
}
