import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { defineKeys } from 'wellcrafted/query';
import { type Result, tryAsync } from 'wellcrafted/result';
import { type DownloadError, DownloadServiceLive } from '#platform/download';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

const RecordingDownloadError = defineErrors({
	AudioUnavailable: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'The audio for this recording is unavailable.',
		cause,
	}),
});
type RecordingDownloadError = InferErrors<typeof RecordingDownloadError>;

export const downloadKeys = defineKeys({
	downloadRecording: ['download', 'downloadRecording'],
});

export function createDownloadQueries(
	app: WhisperingApp,
	{ defineMutation }: Pick<WhisperingQueryRuntime, 'defineMutation'>,
) {
	return {
		downloadRecording: defineMutation({
			mutationKey: downloadKeys.downloadRecording,
			mutationFn: async (
				recording: Recording,
			): Promise<Result<void, RecordingDownloadError | DownloadError>> => {
				const audio = await tryAsync({
					try: () => app.recordings.readPlaybackAudio(recording.id),
					catch: (cause) => RecordingDownloadError.AudioUnavailable({ cause }),
				});
				if (audio.error !== null) return audio;
				if (audio.data === null)
					return RecordingDownloadError.AudioUnavailable();
				if (typeof audio.data === 'string') {
					return DownloadServiceLive.downloadUrl({
						name: recording.audioFileName,
						url: audio.data,
					});
				}

				return DownloadServiceLive.downloadBlob({
					name: recording.audioFileName,
					blob: audio.data,
				});
			},
		}),
	};
}
