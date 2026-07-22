import { defineKeys } from 'wellcrafted/query';
import { Ok, partitionResults } from 'wellcrafted/result';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { Recording } from '$lib/state/recordings.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export function createTranscriptionQueries(
	app: WhisperingApp,
	{
		defineMutation,
		queryClient,
	}: Pick<WhisperingQueryRuntime, 'defineMutation' | 'queryClient'>,
) {
	return {
		isCurrentlyTranscribing() {
			return (
				queryClient.isMutating({
					mutationKey: transcriptionKeys.isTranscribing,
				}) > 0
			);
		},
		transcribeRecording: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: (recording: Recording) =>
				transcribeAndPersist(app, recording.id),
		}),

		transcribeRecordings: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: async (recordings: Recording[]) => {
				const results = await Promise.all(
					recordings.map((recording) =>
						transcribeAndPersist(app, recording.id),
					),
				);
				return Ok(partitionResults(results));
			},
		}),
	};
}
