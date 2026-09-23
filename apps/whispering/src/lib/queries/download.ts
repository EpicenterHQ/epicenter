import {
	type BlobStoreError,
	selectBlobFormat,
} from '@epicenter/blobs';
import { defineKeys } from 'wellcrafted/query';
import { Err, type Result } from 'wellcrafted/result';
import { type DownloadError, DownloadServiceLive } from '#platform/download';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '../data.js';
import type { RecordingStore } from '../whispering/app.js';
import { readRecordingAudio } from '../whispering/recordings.js';

export const downloadKeys = defineKeys({
	downloadRecording: ['download', 'downloadRecording'],
});

export function createDownloadQueries(
	store: RecordingStore,
	{ defineMutation }: Pick<WhisperingQueryRuntime, 'defineMutation'>,
) {
	return {
		downloadRecording: defineMutation({
			mutationKey: downloadKeys.downloadRecording,
			mutationFn: async (
				recording: Recording,
			): Promise<
				Result<void, BlobStoreError | DownloadError>
			> => {
				const { data: audioBlob, error: getAudioBlobError } =
					await readRecordingAudio(store, recording.id);

				if (getAudioBlobError) return Err(getAudioBlobError);

				return DownloadServiceLive.downloadBlob({
					name: `whispering_recording_${recording.id}.${selectBlobFormat(audioBlob).extension}`,
					blob: audioBlob,
				});
			},
		}),
	};
}
