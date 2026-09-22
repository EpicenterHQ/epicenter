import type { BlobStoreError, RemoteBlobsError } from '@epicenter/blobs';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, type Result, tryAsync, trySync } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';
import { type Recording, whisperingDefinition } from '../data.js';

type RemoteAudio = NonNullable<Recording['remoteAudio']>;

import { updateRecording } from '../whispering/recordings.js';

const RecordingUploadError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not upload this recording.',
		cause,
	}),
	ReferenceNotSaved: ({
		reference,
		cause,
	}: {
		reference: RemoteAudio;
		cause: unknown;
	}) => ({
		message:
			'Audio was uploaded, but its reference could not be saved on the recording.',
		reference,
		cause,
	}),
});

/** Upload one saved object and retain the returned scoped reference on its recording row. */
export async function uploadRecording(
	app: Pick<
		WhisperingApp,
		'localBlobs' | 'remoteBlobs' | 'personal' | 'library' | 'signal'
	>,
	recording: Recording,
	signal: AbortSignal,
): Promise<
	Result<
		RemoteAudio,
		BlobStoreError | RemoteBlobsError | InferErrors<typeof RecordingUploadError>
	>
> {
	const personal = app.personal;
	const attempt = await tryAsync({
		try: async () => {
			if (!app.remoteBlobs || !personal)
				return RecordingUploadError.Failed({
					cause: 'Sign in before uploading audio.',
				});
			return app.remoteBlobs.copyFrom(app.localBlobs, recording.audioBlobId, {
				signal,
			});
		},
		catch: (cause) => RecordingUploadError.Failed({ cause }),
	});
	if (attempt.error) return attempt;
	if (attempt.data.error) return Err(attempt.data.error);
	const reference: RemoteAudio = {
		blobId: attempt.data.data,
		authorityId: personal!.identity.authorityId,
		principalId: personal!.identity.principalId,
		namespace: whisperingDefinition.id,
	};
	return trySync({
		try: () => {
			signal.throwIfAborted();
			app.signal.throwIfAborted();
			updateRecording(app.library, recording.id, { remoteAudio: reference });
			return reference;
		},
		catch: (cause) =>
			RecordingUploadError.ReferenceNotSaved({ reference, cause }),
	});
}
