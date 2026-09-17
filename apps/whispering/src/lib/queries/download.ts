import {
	type BlobNotFound,
	type BlobStoreFailed,
	type RemoteBlobsError,
	selectBlobFormat,
} from '@epicenter/blobs';
import { defineKeys } from 'wellcrafted/query';
import { Err, type Result } from 'wellcrafted/result';
import { type DownloadError, DownloadServiceLive } from '#platform/download';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

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
			): Promise<
				Result<
					void,
					BlobNotFound | BlobStoreFailed | RemoteBlobsError | DownloadError
				>
			> => {
				const { data: audioBlob, error: getAudioBlobError } =
					await app.recordings.readAudio(recording.id);

				if (getAudioBlobError) return Err(getAudioBlobError);

				return DownloadServiceLive.downloadBlob({
					name: `whispering_recording_${recording.id}.${selectBlobFormat(audioBlob).extension}`,
					blob: audioBlob,
				});
			},
		}),
	};
}
