/** Blob capabilities are borrowed; recording accepts only a Local destination. */
import type { BlobId } from '@epicenter/blobs';
import type { LocalBlobs, PersonalBlobs } from './blobs.js';
import { createRecorder } from './recorder.js';
export function blobContracts(
	localBlobs: LocalBlobs,
	remoteBlobs: PersonalBlobs,
	id: BlobId,
) {
	createRecorder({ localBlobs });
	remoteBlobs.copyFrom(localBlobs, id);
	// @ts-expect-error The store owns close.
	localBlobs.close();
	// @ts-expect-error The store owns admission.
	localBlobs.signal;
	// @ts-expect-error The store owns close.
	remoteBlobs.close();
	// @ts-expect-error Recorders publish only locally.
	createRecorder({ localBlobs: remoteBlobs });
	// @ts-expect-error Blob capabilities do not own capture.
	localBlobs.recorder;
	// @ts-expect-error Raw arbitrary-ID publication is private.
	localBlobs.put(id, new Blob());
}

export function copyContracts(
	local: LocalBlobs,
	personal: PersonalBlobs,
	id: BlobId,
) {
	local.copyFrom(local, id);
	local.copyFrom(personal, id);
	personal.copyFrom(local, id);
	personal.add(new Blob());
	// @ts-expect-error Personal-to-Personal is deferred.
	personal.copyFrom(personal, id);
	// @ts-expect-error Structural fake sources have no provenance.
	personal.copyFrom({ get: local.get }, id);
	// @ts-expect-error Copy has no destination ID override.
	personal.copyFrom(local, id, { destinationId: id });
	// @ts-expect-error Upload alias is removed.
	personal.upload(local, id);
}
