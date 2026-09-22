import { updateRecording } from '../whispering/recordings.js';
import { defineErrors } from 'wellcrafted/error';
import { Err, tryAsync, trySync } from 'wellcrafted/result';
import type { Recording } from '../data.js';
import type { WhisperingApp } from '$lib/whispering/app';

const RecordingUploadError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not upload this recording.',
		cause,
	}),
});

/** Upload one saved object and retain the returned URL on its recording row. */
export async function uploadRecording(
	app: Pick<WhisperingApp, 'localBlobs' | 'remoteBlobs' | 'library' | 'signal'>,
	recording: Recording,
	signal: AbortSignal,
) {
	const attempt = await tryAsync({
		try: async () => {
			if (!app.remoteBlobs)
				return RecordingUploadError.Failed({
					cause: 'Sign in before uploading audio.',
				});
			return app.remoteBlobs.addFrom(app.localBlobs, recording.audioBlobId, {
				signal,
			});
		},
		catch: (cause) => RecordingUploadError.Failed({ cause }),
	});
	if (attempt.error) return attempt;
	if (attempt.data.error) return Err(attempt.data.error);
	const url = attempt.data.data;
	return trySync({
		try: () => {
			signal.throwIfAborted();
			app.signal.throwIfAborted();
			updateRecording(app.library, recording.id, { audioUrl: url });
			return url;
		},
		catch: (cause) => RecordingUploadError.Failed({ cause }),
	});
}
