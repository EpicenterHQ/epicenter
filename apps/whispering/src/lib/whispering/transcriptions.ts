import type { Transcription } from '../data.js';
import type { WhisperingData } from './app.js';

/** The most recently attempted successful result for one audio source. */
export function transcriptionsForRecording(
	store: Pick<WhisperingData, 'tables'>,
	recordingId: string,
): Transcription[] {
	return store.tables.transcriptions.rows
		.filter((result) => result.recordingId === recordingId)
		.toSorted((left, right) =>
			right.attemptedAt.localeCompare(left.attemptedAt) ||
			right.id.localeCompare(left.id),
		);
}

export function latestTranscription(
	store: Pick<WhisperingData, 'tables'>,
	recordingId: string,
): Transcription | undefined {
	return transcriptionsForRecording(store, recordingId)[0];
}

export function transcriptionText(result: Transcription | undefined): string {
	return result?.cleanedText ?? result?.rawText ?? '';
}
