import type { BlobNotFound, BlobStoreFailed } from '@epicenter/blobs';
import { defineKeys } from 'wellcrafted/query';
import { Err, type Result } from 'wellcrafted/result';
import type { DownloadError } from '#platform/download';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import { services } from '$lib/services';
import type { Recording } from '$lib/state/recordings.svelte';

export const downloadKeys = defineKeys({
	downloadRecording: ['download', 'downloadRecording'],
});

export function createDownloadQueries({
	defineMutation,
}: Pick<WhisperingQueryRuntime, 'defineMutation'>) {
	return {
		downloadRecording: defineMutation({
			mutationKey: downloadKeys.downloadRecording,
			mutationFn: async (
				recording: Recording,
			): Promise<
				Result<void, BlobNotFound | BlobStoreFailed | DownloadError>
			> => {
				const { data: audioBlob, error: getAudioBlobError } =
					await services.blobs.local.get(recording.audioBlobId);

				if (getAudioBlobError) return Err(getAudioBlobError);

				return services.download.downloadBlob({
					name: `whispering_recording_${recording.id}`,
					blob: audioBlob,
				});
			},
		}),
	};
}
