import { defineErrors } from 'wellcrafted/error';
import { Err, tryAsync, trySync } from 'wellcrafted/result';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

const RecordingUploadError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: 'Could not upload this recording.',
		cause,
	}),
});

/** Upload one saved object and retain the returned URL on its recording row. */
export async function uploadRecording(
	app: WhisperingApp,
	recording: Recording,
	signal: AbortSignal,
) {
	const attempt = await tryAsync({
		try: async () => {
			if (!('remote' in app.blobs))
				return RecordingUploadError.Failed({
					cause: 'Sign in before uploading audio.',
				});
			return app.blobs.remote.addLocal(recording.audioBlobId, { signal });
		},
		catch: (cause) => RecordingUploadError.Failed({ cause }),
	});
	if (attempt.error) return attempt;
	if (attempt.data.error) return Err(attempt.data.error);
	const url = attempt.data.data;
	return trySync({
		try: () => {
			app.signal.throwIfAborted();
			app.recordings.patch(recording.id, { audioUrl: url });
			return url;
		},
		catch: (cause) => RecordingUploadError.Failed({ cause }),
	});
}
