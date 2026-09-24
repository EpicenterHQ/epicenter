import { InstantString } from '@epicenter/app/field';
import type { BlobId } from '@epicenter/blobs';
import { defineErrors } from 'wellcrafted/error';
import { Ok, trySync } from 'wellcrafted/result';
import type { WhisperingApp } from '../whispering/app.js';
import { local } from '../whispering/local.js';
import { newRecordingValues } from '../whispering/recordings.js';
import { recordingPublication } from './publish-recording.js';

const AudioSaveError = defineErrors({
	AdmissionFailed: ({ cause }: { cause: unknown }) => ({
		message: 'Finish pending saves before saving more recordings.',
		cause,
	}),
});

/** Imports and VAD retain one Local byte publication and one durable row attempt. */
export async function saveAudioRecording(
	app: Pick<WhisperingApp, 'signal' | 'pendingSaves'>,
	audio: Blob,
	reserved?: ReturnType<WhisperingApp['pendingSaves']['reserve']>,
) {
	const admission = trySync({
		try: () => reserved ?? app.pendingSaves.reserve('Local recording'),
		catch: (cause) => AudioSaveError.AdmissionFailed({ cause }),
	});
	if (admission.error) return admission;
	const receipt = admission.data;
	const recordedAt = InstantString.now();
	const recordedAtZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	let attempted = false;
	let blobId: BlobId | undefined;
	let publication: ReturnType<typeof recordingPublication> | undefined;
	const result = await receipt.run(async () => {
		if (!attempted) {
			app.signal.throwIfAborted();
			attempted = true;
			const saved = await local.blobs.add(audio);
			if (saved.error) {
				// The storage API names the attempted immutable destination even when its
				// durable publication is uncertain. Retain it; never call add again.
				if (saved.error.name === 'BlobAlreadyExists') {
					receipt.discard();
					return saved;
				}
				blobId = saved.error.id;
				return saved;
			}
			blobId = saved.data;
			publication = recordingPublication(
				local,
				newRecordingValues({
					audioBlobId: blobId,
					recordedAt,
					recordedAtZone,
					duration: null,
				}),
				app.signal,
			);
		}
		if (!blobId)
			throw new Error(
				'Byte publication acceptance is uncertain; no destination ID was returned.',
			);
		if (!publication) {
			const bytes = await local.blobs.get(blobId);
			if (bytes.error) return bytes;
			publication = recordingPublication(
				local,
				newRecordingValues({
					audioBlobId: blobId,
					recordedAt,
					recordedAtZone,
					duration: null,
				}),
				app.signal,
			);
		}
		return publication();
	});
	return app.signal.aborted ? Ok(null) : result;
}
