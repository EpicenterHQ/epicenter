import { defineKeys } from 'wellcrafted/query';
import { Ok, partitionResults } from 'wellcrafted/result';
import { transcribeAndPersist } from '$lib/operations/transcribe';
import type { WhisperingQueryRuntime } from '$lib/queries/client';
import type { WhisperingApp } from '$lib/whispering/app';
import type { Recording } from '../data.js';
import type { RecordingStore } from '../whispering/app.js';

function retry(
	app: WhisperingApp,
	store: RecordingStore,
	recording: Recording,
) {
	if (!app.recordingEnabled) throw new Error('Whispering is closing.');
	return transcribeAndPersist(app, store, recording.id);
}

export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export function createTranscriptionQueries(
	app: WhisperingApp,
	store: RecordingStore,
	{ defineMutation }: Pick<WhisperingQueryRuntime, 'defineMutation'>,
) {
	return {
		transcribeRecording: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: (recording: Recording) => retry(app, store, recording),
		}),

		transcribeRecordings: defineMutation({
			mutationKey: transcriptionKeys.isTranscribing,
			mutationFn: async (recordings: Recording[]) => {
				const results = await Promise.all(
					recordings.map((recording) => retry(app, store, recording)),
				);
				return Ok(partitionResults(results));
			},
		}),
	};
}
